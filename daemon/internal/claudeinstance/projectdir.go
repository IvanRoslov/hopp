package claudeinstance

import (
	"strconv"
	"unicode/utf16"

	"golang.org/x/text/unicode/norm"
)

// projectDirMax is the longest folder name Claude Code keeps whole under
// <config>/projects/.
const projectDirMax = 200

// ProjectDirName is the name of the folder Claude Code keeps a project's
// journals in, under <config>/projects/, for the working directory path.
// It is Claude Code 2.1.327's rule, read from its code and checked against
// the folders it made (projectdir_test.go):
//
//   - the path is put in Unicode NFC;
//   - every UTF-16 code unit that is not an ASCII letter or digit becomes
//     "-" (so a non-ASCII letter is one "-", an emoji two);
//   - a name of more than 200 units is cut to 200 and gets "-" and the
//     path's hash: the Java-style string hash of its UTF-16 units (h =
//     31*h + unit, in 32 bits), its absolute value in base 36.
//
// The path must be the resolved one Claude Code sees as its cwd.
func ProjectDirName(path string) string {
	units := utf16.Encode([]rune(norm.NFC.String(path)))
	out := make([]byte, len(units))
	var h int32
	for i, u := range units {
		h = h*31 + int32(u)
		if u < 128 && (u >= '0' && u <= '9' || u >= 'A' && u <= 'Z' || u >= 'a' && u <= 'z') {
			out[i] = byte(u)
		} else {
			out[i] = '-'
		}
	}
	if len(out) <= projectDirMax {
		return string(out)
	}
	abs := int64(h)
	if abs < 0 {
		abs = -abs // math.MinInt32 stays representable in 64 bits, as in JS
	}
	return string(out[:projectDirMax]) + "-" + strconv.FormatInt(abs, 36)
}
