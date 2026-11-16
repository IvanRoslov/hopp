//go:build !darwin

package artifacts

import "os"

// copyFile copies the open file in to dst.
func copyFile(in *os.File, dst string) error {
	return plainCopy(in, dst)
}
