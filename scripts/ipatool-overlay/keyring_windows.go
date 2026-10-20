//go:build windows

package cmd

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
	"unsafe"

	"github.com/byteness/keyring"
	"github.com/majd/ipatool/v2/pkg/keychain"
)

// The OS user protects these bytes across processes. Never fall back to the
// legacy passphrase file backend: that would recreate the login/read split.
type dpapiKeyring struct{ directory string }
type dataBlob struct {
	Size uint32
	Data *byte
}

var crypt32 = syscall.NewLazyDLL("crypt32.dll")
var kernel32 = syscall.NewLazyDLL("kernel32.dll")

func openKeyring(config keyring.Config) (keychain.Keyring, error) {
	directory := filepath.Join(config.FileDir, "apptrace-dpapi-v1")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	return &dpapiKeyring{directory: directory}, nil
}

func protectData(input []byte, decrypt bool) ([]byte, error) {
	var source, output dataBlob
	source.Size = uint32(len(input))
	if len(input) > 0 {
		source.Data = &input[0]
	}
	name := "CryptProtectData"
	if decrypt {
		name = "CryptUnprotectData"
	}
	// CRYPTPROTECT_UI_FORBIDDEN, deliberately without LOCAL_MACHINE.
	ok, _, err := crypt32.NewProc(name).Call(uintptr(unsafe.Pointer(&source)), 0, 0, 0, 0, 1, uintptr(unsafe.Pointer(&output)))
	runtime.KeepAlive(input)
	if ok == 0 {
		return nil, fmt.Errorf("APPTRACE_CREDENTIAL_ACCESS_FAILED: %w", err)
	}
	defer kernel32.NewProc("LocalFree").Call(uintptr(unsafe.Pointer(output.Data)))
	return append([]byte(nil), unsafe.Slice(output.Data, int(output.Size))...), nil
}

func (k *dpapiKeyring) filename(key string) string {
	return filepath.Join(k.directory, fmt.Sprintf("%x.bin", sha256.Sum256([]byte(key))))
}

func (k *dpapiKeyring) Get(key string) (keyring.Item, error) {
	filename, err := syscall.UTF16PtrFromString(k.filename(key))
	if err != nil {
		return keyring.Item{}, err
	}
	// Permit atomic replacement while another process reads the old version.
	handle, err := syscall.CreateFile(filename, syscall.GENERIC_READ, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|4, nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
		return keyring.Item{}, keyring.ErrKeyNotFound
	}
	if err != nil {
		return keyring.Item{}, fmt.Errorf("APPTRACE_CREDENTIAL_ACCESS_FAILED: %w", err)
	}
	file := os.NewFile(uintptr(handle), k.filename(key))
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		return keyring.Item{}, fmt.Errorf("APPTRACE_CREDENTIAL_ACCESS_FAILED: %w", err)
	}
	plain, err := protectData(data, true)
	return keyring.Item{Key: key, Data: plain}, err
}

func (k *dpapiKeyring) Set(item keyring.Item) error {
	if _, err := k.Get(item.Key); err != nil && !errors.Is(err, keyring.ErrKeyNotFound) {
		return err
	}
	data, err := protectData(item.Data, false)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(k.directory, "credential-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err = file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	// Windows may transiently deny replacement while closing a shared reader.
	// Keep the old complete ciphertext until replacement succeeds.
	for attempt := 0; attempt < 30; attempt++ {
		err = os.Rename(file.Name(), k.filename(item.Key))
		if err == nil {
			return nil
		}
		if !errors.Is(err, syscall.ERROR_ACCESS_DENIED) && !errors.Is(err, syscall.Errno(32)) {
			return err
		}
		time.Sleep(10 * time.Millisecond)
	}
	return err
}

func (k *dpapiKeyring) Remove(key string) error {
	err := os.Remove(k.filename(key))
	if errors.Is(err, os.ErrNotExist) {
		return keyring.ErrKeyNotFound
	}
	return err
}
