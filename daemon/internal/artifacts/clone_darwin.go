package artifacts

import (
	"os"

	"golang.org/x/sys/unix"
)

// copyFile clones the open file in to dst (APFS copy-on-write), and copies
// it when the file system cannot clone.
func copyFile(in *os.File, dst string) error {
	if err := unix.Fclonefileat(int(in.Fd()), unix.AT_FDCWD, dst, 0); err == nil {
		return nil
	}
	os.Remove(dst)
	return plainCopy(in, dst)
}
