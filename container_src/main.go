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
	instanceId := os.Getenv("CLOUDFLARE_DEPLOYMENT_ID")
	fmt.Printf("DHi, I'm a container and this is my message: \"%s\", my instance ID is: %s\n", message, instanceId)
	fmt.Fprintf(w, "DHi, I'm a container and this is my message: \"%s\", my instance ID is: %s", message, instanceId)
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
	
	data := make([]byte, size)
	rand.Read(data)
	w.Write(data)
}

func main() {
	http.HandleFunc("/", handler)
	http.HandleFunc("/container", handler)
	http.HandleFunc("/error", errorHandler)
	http.HandleFunc("/random", randomDataHandler)
	log.Fatal(http.ListenAndServe(":8080", nil))
}
