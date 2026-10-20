// Controlled process fixture. Never connects to Apple or reads real credentials.
package main

import (
	"fmt"
	"os"
	"path/filepath"
)

func main() {
	args := os.Args[1:]
	root := os.Getenv("APPTRACE_WORKSPACE_ROOT")
	if len(args) > 0 && args[0] == "--version" { fmt.Println("fixture-apptrace-dpapi-v1"); return }
	if len(args) > 1 && args[0] == "auth" && args[1] == "login" { fmt.Println("controlled interactive command succeeded"); return }
	if len(args) > 1 && args[0] == "auth" && args[1] == "info" {
		if _, err := os.Stat(filepath.Join(root, "fixture-ready")); err != nil { fmt.Println(`{"success":false,"error":"not logged in"}`); os.Exit(1) }
		fmt.Println(`{"success":true,"email":"fixture@example.org","name":"Controlled fixture"}`)
		return
	}
	if len(args) > 0 && args[0] == "download" {
		for i, arg := range args { if arg == "--output" && i+1 < len(args) {
			if err := os.WriteFile(args[i+1], []byte("synthetic package for orchestration verification only"), 0600); err != nil { panic(err) }
			log, err := os.OpenFile(filepath.Join(root, "fixture-downloads"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
			if err != nil { panic(err) }; defer log.Close(); fmt.Fprintln(log, "download"); return
		} }
	}
	fmt.Fprintln(os.Stderr, "fixture received unsupported operation")
	os.Exit(2)
}
