use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fuser::{
    FileAttr, FileType, Filesystem, MountOption, ReplyAttr, ReplyData, ReplyDirectory, ReplyEntry,
    ReplyOpen, ReplyWrite, ReplyCreate, Request,
};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

#[derive(Serialize)]
struct FSMessage {
    id: u64,
    operation: String,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
}

#[derive(Deserialize)]
struct FSResponse {
    id: u64,
    #[serde(default)]
    data: Vec<u8>,
    #[serde(rename = "bytesWritten", default)]
    bytes_written: u64,
    #[serde(default)]
    files: Vec<String>,
    stat: Option<FileStat>,
    #[serde(default)]
    success: bool,
    #[serde(default)]
    error: String,
}

#[derive(Deserialize)]
struct FileStat {
    size: u64,
    #[serde(rename = "isFile")]
    is_file: bool,
    #[serde(rename = "isDir")]
    is_dir: bool,
    mtime: u64,
}

struct RemoteFSClient {
    stream: Arc<Mutex<TcpStream>>,
    request_id: Arc<Mutex<u64>>,
    pending_requests: Arc<Mutex<HashMap<u64, oneshot::Sender<FSResponse>>>>,
}

impl RemoteFSClient {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        // Listen for incoming connection from DO
        let listener = std::net::TcpListener::bind("10.0.0.1:8000")?;
        println!("Filesystem daemon listening on 10.0.0.1:8000");
        
        let (stream, _) = listener.accept()?;
        println!("Filesystem daemon connected to DO");
        let stream = Arc::new(Mutex::new(stream));
        let request_id = Arc::new(Mutex::new(0));
        let pending_requests = Arc::new(Mutex::new(HashMap::new()));

        // Start reader thread
        let stream_clone = stream.clone();
        let pending_clone = pending_requests.clone();
        thread::spawn(move || {
            Self::reader_loop(stream_clone, pending_clone);
        });

        Ok(Self {
            stream,
            request_id,
            pending_requests,
        })
    }

    fn reader_loop(
        stream: Arc<Mutex<TcpStream>>,
        pending: Arc<Mutex<HashMap<u64, oneshot::Sender<FSResponse>>>>,
    ) {
        loop {
            let mut length_buf = [0u8; 4];
            let mut stream = stream.lock().unwrap();
            
            if stream.read_exact(&mut length_buf).is_err() {
                break;
            }
            
            let message_length = u32::from_le_bytes(length_buf) as usize;
            let mut message_buf = vec![0u8; message_length];
            
            if stream.read_exact(&mut message_buf).is_err() {
                break;
            }
            
            drop(stream);

            if let Ok(response) = serde_json::from_slice::<FSResponse>(&message_buf) {
                let mut pending = pending.lock().unwrap();
                if let Some(sender) = pending.remove(&response.id) {
                    let _ = sender.send(response);
                }
            }
        }
    }

    async fn send_request(
        &self,
        operation: &str,
        path: &str,
        data: Option<Vec<u8>>,
        offset: Option<u64>,
        size: Option<u64>,
    ) -> Result<FSResponse, Box<dyn std::error::Error>> {
        let (tx, rx) = oneshot::channel();
        
        let id = {
            let mut request_id = self.request_id.lock().unwrap();
            *request_id += 1;
            *request_id
        };

        {
            let mut pending = self.pending_requests.lock().unwrap();
            pending.insert(id, tx);
        }

        let message = FSMessage {
            id,
            operation: operation.to_string(),
            path: path.to_string(),
            data,
            offset,
            size,
        };

        let message_data = serde_json::to_vec(&message)?;
        let length_prefix = (message_data.len() as u32).to_le_bytes();

        {
            let mut stream = self.stream.lock().unwrap();
            stream.write_all(&length_prefix)?;
            stream.write_all(&message_data)?;
        }

        match tokio::time::timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(response)) => {
                if !response.error.is_empty() {
                    return Err(response.error.into());
                }
                Ok(response)
            }
            Ok(Err(_)) => Err("Channel error".into()),
            Err(_) => Err("Request timeout".into()),
        }
    }
}

struct RemoteFS {
    client: RemoteFSClient,
    next_fh: Arc<Mutex<u64>>,
}

impl RemoteFS {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let client = RemoteFSClient::new()?;
        Ok(Self {
            client,
            next_fh: Arc::new(Mutex::new(1)),
        })
    }

    fn get_attr_from_stat(&self, stat: &FileStat) -> FileAttr {
        FileAttr {
            ino: 1,
            size: stat.size,
            blocks: (stat.size + 511) / 512,
            atime: UNIX_EPOCH + Duration::from_millis(stat.mtime),
            mtime: UNIX_EPOCH + Duration::from_millis(stat.mtime),
            ctime: UNIX_EPOCH + Duration::from_millis(stat.mtime),
            crtime: UNIX_EPOCH + Duration::from_millis(stat.mtime),
            kind: if stat.is_file { FileType::RegularFile } else { FileType::Directory },
            perm: if stat.is_file { 0o644 } else { 0o755 },
            nlink: 1,
            uid: unsafe { libc::getuid() },
            gid: unsafe { libc::getgid() },
            rdev: 0,
            flags: 0,
            blksize: 4096,
        }
    }
}

impl Filesystem for RemoteFS {
    fn lookup(&mut self, _req: &Request, parent: u64, name: &OsStr, reply: ReplyEntry) {
        let path = format!("/{}", name.to_string_lossy());
        
        let rt = tokio::runtime::Runtime::new().unwrap();
        match rt.block_on(self.client.send_request("stat", &path, None, None, None)) {
            Ok(response) => {
                if let Some(stat) = response.stat {
                    let attr = self.get_attr_from_stat(&stat);
                    reply.entry(&Duration::from_secs(1), &attr, 0);
                } else {
                    reply.error(libc::ENOENT);
                }
            }
            Err(_) => reply.error(libc::ENOENT),
        }
    }

    fn getattr(&mut self, _req: &Request, ino: u64, reply: ReplyAttr) {
        let path = if ino == 1 { "/" } else { "/unknown" };
        
        let rt = tokio::runtime::Runtime::new().unwrap();
        match rt.block_on(self.client.send_request("stat", path, None, None, None)) {
            Ok(response) => {
                if let Some(stat) = response.stat {
                    let attr = self.get_attr_from_stat(&stat);
                    reply.attr(&Duration::from_secs(1), &attr);
                } else {
                    reply.error(libc::ENOENT);
                }
            }
            Err(_) => reply.error(libc::ENOENT),
        }
    }

    fn read(
        &mut self,
        _req: &Request,
        ino: u64,
        fh: u64,
        offset: i64,
        size: u32,
        _flags: i32,
        _lock: Option<u64>,
        reply: ReplyData,
    ) {
        let path = "/"; // Would need to track path by inode
        
        let rt = tokio::runtime::Runtime::new().unwrap();
        match rt.block_on(self.client.send_request(
            "read",
            path,
            None,
            Some(offset as u64),
            Some(size as u64),
        )) {
            Ok(response) => reply.data(&response.data),
            Err(_) => reply.error(libc::EIO),
        }
    }

    fn write(
        &mut self,
        _req: &Request,
        ino: u64,
        fh: u64,
        offset: i64,
        data: &[u8],
        _write_flags: u32,
        _flags: i32,
        _lock_owner: Option<u64>,
        reply: ReplyWrite,
    ) {
        let path = "/"; // Would need to track path by inode
        
        let rt = tokio::runtime::Runtime::new().unwrap();
        match rt.block_on(self.client.send_request(
            "write",
            path,
            Some(data.to_vec()),
            Some(offset as u64),
            None,
        )) {
            Ok(response) => reply.written(response.bytes_written as u32),
            Err(_) => reply.error(libc::EIO),
        }
    }

    fn readdir(
        &mut self,
        _req: &Request,
        ino: u64,
        fh: u64,
        offset: i64,
        mut reply: ReplyDirectory,
    ) {
        let path = if ino == 1 { "/" } else { "/unknown" };
        
        let rt = tokio::runtime::Runtime::new().unwrap();
        match rt.block_on(self.client.send_request("readdir", path, None, None, None)) {
            Ok(response) => {
                for (i, file) in response.files.iter().enumerate() {
                    if i as i64 >= offset {
                        reply.add(i as u64 + 2, (i + 1) as i64, FileType::RegularFile, file);
                    }
                }
                reply.ok();
            }
            Err(_) => reply.error(libc::EIO),
        }
    }

    fn open(&mut self, _req: &Request, ino: u64, flags: i32, reply: ReplyOpen) {
        let fh = {
            let mut next_fh = self.next_fh.lock().unwrap();
            *next_fh += 1;
            *next_fh
        };
        reply.opened(fh, 0);
    }

    fn create(
        &mut self,
        _req: &Request,
        parent: u64,
        name: &OsStr,
        mode: u32,
        umask: u32,
        flags: i32,
        reply: ReplyCreate,
    ) {
        let path = format!("/{}", name.to_string_lossy());
        
        let rt = tokio::runtime::Runtime::new().unwrap();
        match rt.block_on(self.client.send_request("write", &path, Some(vec![]), None, None)) {
            Ok(_) => {
                // Return fake attributes for created file
                let attr = FileAttr {
                    ino: 2,
                    size: 0,
                    blocks: 0,
                    atime: SystemTime::now(),
                    mtime: SystemTime::now(),
                    ctime: SystemTime::now(),
                    crtime: SystemTime::now(),
                    kind: FileType::RegularFile,
                    perm: 0o644,
                    nlink: 1,
                    uid: unsafe { libc::getuid() },
                    gid: unsafe { libc::getgid() },
                    rdev: 0,
                    flags: 0,
                    blksize: 4096,
                };
                let fh = {
                    let mut next_fh = self.next_fh.lock().unwrap();
                    *next_fh += 1;
                    *next_fh
                };
                reply.created(&Duration::from_secs(1), &attr, 0, fh, 0);
            }
            Err(_) => reply.error(libc::EIO),
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mount_point = "/storage";
    std::fs::create_dir_all(mount_point)?;

    println!("Mounting remote filesystem at {}", mount_point);

    let fs = RemoteFS::new()?;
    
    let options = vec![
        MountOption::AllowOther,
        MountOption::AutoUnmount,
    ];

    fuser::mount2(fs, mount_point, &options)?;
    
    Ok(())
}