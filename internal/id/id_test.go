package id

import (
	"strings"
	"testing"
)

func TestNewIsPrefixedAndUnique(t *testing.T) {
	a, err := New("usr")
	if err != nil {
		t.Fatal(err)
	}
	b, err := New("usr")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(a, "usr_") || a == b {
		t.Fatalf("unexpected identifiers %q and %q", a, b)
	}
}

func TestSecretRejectsShortValues(t *testing.T) {
	if _, err := Secret(15); err == nil {
		t.Fatal("expected short secret to fail")
	}
}

func TestHashSecretIsDeterministic(t *testing.T) {
	a := HashSecret("value")
	b := HashSecret("value")
	c := HashSecret("other")
	if a != b || a == c {
		t.Fatal("secret hashing is not deterministic and distinct")
	}
}
