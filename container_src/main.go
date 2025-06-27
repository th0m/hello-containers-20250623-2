package main

import (
	"crypto/rand"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
)

func handler(w http.ResponseWriter, r *http.Request) {
	message := os.Getenv("MESSAGE")
	secret := os.Getenv("MYSECRET")
	instanceId := os.Getenv("CLOUDFLARE_DEPLOYMENT_ID")
	
	// Test writing to persistent storage
	counterFile := "/storage/visit_counter.txt"
	counter := 1
	
	// Read existing counter
	if data, err := os.ReadFile(counterFile); err == nil {
		if count, err := strconv.Atoi(string(data)); err == nil {
			counter = count + 1
		}
	}
	
	// Write new counter
	os.WriteFile(counterFile, []byte(strconv.Itoa(counter)), 0644)
	
	messageToPrint := fmt.Sprintf("Hi, I'm a container! Message: \"%s\", Secret: \"%s\", Instance: %s, Visit: %d", 
		message, secret, instanceId, counter)
	fmt.Println(messageToPrint)
	fmt.Fprint(w, messageToPrint)
}

func errorHandler(w http.ResponseWriter, r *http.Request) {
	panic("This is a panic")
}

func randomDataHandler(w http.ResponseWriter, r *http.Request) {
	sizeParam := r.URL.Query().Get("size")
	size := 1024
	if sizeParam != "" {
		if parsedSize, err := strconv.Atoi(sizeParam); err == nil && parsedSize > 0 {
			size = parsedSize
		}
	}

	w.Header().Set("Content-Type", "application/octet-stream")

	chunkSize := 64 * 1024 // 64KB chunks
	buffer := make([]byte, chunkSize)
	flushCounter := 0

	for remaining := size; remaining > 0; {
		currentChunk := min(remaining, chunkSize)

		rand.Read(buffer[:currentChunk])
		w.Write(buffer[:currentChunk])
		remaining -= currentChunk
		flushCounter++

		// Flush every 16 chunks (1MB) instead of every chunk
		if flushCounter%16 == 0 {
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
	}

	// Final flush
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}

func main() {
	http.HandleFunc("/", handler)
	http.HandleFunc("/container", handler)
	http.HandleFunc("/error", errorHandler)
	http.HandleFunc("/random", randomDataHandler)
	log.Fatal(http.ListenAndServe(":80", nil))
}
