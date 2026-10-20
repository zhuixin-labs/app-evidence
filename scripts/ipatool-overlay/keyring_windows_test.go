//go:build windows

package cmd

import (
	"bytes"
	"github.com/byteness/keyring"
	"os"
	"os/exec"
	"sync"
	"testing"
)

func TestDPAPICrossProcess(t *testing.T) {
	if dir := os.Getenv("APPTRACE_DPAPI_TEST_DIR"); dir != "" {
		store := &dpapiKeyring{directory: dir}
		item, err := store.Get("test-only")
		if err != nil || !bytes.Equal(item.Data, bytes.Repeat([]byte("test-only-secret"), 1000)) {
			t.Fatal("cross-process read failed", err)
		}
		return
	}
	store := &dpapiKeyring{directory: t.TempDir()}
	secret := bytes.Repeat([]byte("test-only-secret"), 1000)
	if err := store.Set(keyring.Item{Key: "test-only", Data: secret}); err != nil {
		t.Fatal(err)
	}
	ciphertext, _ := os.ReadFile(store.filename("test-only"))
	if bytes.Contains(ciphertext, []byte("test-only-secret")) {
		t.Fatal("plaintext on disk")
	}
	child := exec.Command(os.Args[0], "-test.run=^TestDPAPICrossProcess$")
	child.Env = append(os.Environ(), "APPTRACE_DPAPI_TEST_DIR="+store.directory)
	if output, err := child.CombinedOutput(); err != nil {
		t.Fatalf("child failed: %s %v", output, err)
	}
	if err := store.Set(keyring.Item{Key: "test-only", Data: []byte("updated")}); err != nil {
		t.Fatal("replace failed", err)
	}
	if err := store.Remove("test-only"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get("test-only"); err != keyring.ErrKeyNotFound {
		t.Fatal("missing credential classification", err)
	}
}

func TestDPAPIRejectsCorruption(t *testing.T) {
	store := &dpapiKeyring{directory: t.TempDir()}
	if err := os.WriteFile(store.filename("corrupt"), []byte("invalid cipher"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get("corrupt"); err == nil {
		t.Fatal("corruption accepted")
	}
	if err := store.Set(keyring.Item{Key: "corrupt", Data: []byte("replacement")}); err == nil {
		t.Fatal("corrupt credential overwritten")
	}
}

func TestDPAPIConcurrentReaders(t *testing.T) {
	store := &dpapiKeyring{directory: t.TempDir()}
	if err := store.Set(keyring.Item{Key: "concurrent", Data: []byte("valid")}); err != nil {
		t.Fatal(err)
	}
	var readers sync.WaitGroup
	for i := 0; i < 4; i++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for j := 0; j < 30; j++ {
				item, err := store.Get("concurrent")
				if err != nil || string(item.Data) != "valid" {
					t.Error("partial credential read", err)
				}
			}
		}()
	}
	for j := 0; j < 30; j++ {
		if err := store.Set(keyring.Item{Key: "concurrent", Data: []byte("valid")}); err != nil {
			t.Error(err)
		}
	}
	readers.Wait()
}
