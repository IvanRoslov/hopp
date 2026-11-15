package store

import (
	"testing"
)

func TestSessionDeliverySnapshotRoundTrip(t *testing.T) {
	s := openTestStore(t)
	if err := s.AddSession(Session{
		ID: "s", Agent: "pi", WorktreePath: "/tmp/s", TmuxName: "s", State: "running",
		DeliveryTransport: "pi-uds-v1", DeliveryInstance: "launch-1", DeliveryEndpoint: "/tmp/pi.sock",
	}); err != nil {
		t.Fatal(err)
	}
	sess, err := s.GetSession("s")
	if err != nil {
		t.Fatal(err)
	}
	assertNativeSession(t, sess, "pi-uds-v1", "launch-1", "/tmp/pi.sock")

	if err := s.UpdateSessionDelivery("s", "pi-uds-v1", "launch-2", "/tmp/new.sock"); err != nil {
		t.Fatal(err)
	}
	sess, _ = s.GetSession("s")
	assertNativeSession(t, sess, "pi-uds-v1", "launch-2", "/tmp/new.sock")
	if sess.Agent != "pi" || sess.State != "running" {
		t.Fatalf("delivery update clobbered session: %+v", sess)
	}
}

func TestClaimNativeMessagePersistsBeforeSend(t *testing.T) {
	s := openTestStore(t)
	id, err := s.AddMessage(Message{ToSession: "s", Body: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	ok, err := s.ClaimNativeMessage(id, "pi-uds-v1", 1234)
	if err != nil || !ok {
		t.Fatalf("ClaimNativeMessage = %v, %v", ok, err)
	}
	msg, err := s.GetMessage(id)
	if err != nil {
		t.Fatal(err)
	}
	if msg.Status != "delivering" || msg.DeliveryTransport != "pi-uds-v1" || msg.InjectAt != 1234 {
		t.Fatalf("claimed message = %+v", msg)
	}
	if ok, _ := s.ClaimNativeMessage(id, "pi-uds-v1", 9999); ok {
		t.Fatal("second native claim won while delivering")
	}
	if err := s.SetMessageNativeDelivery(id, "pi-uds-v1", 5678); err != nil {
		t.Fatal(err)
	}
	msg, _ = s.GetMessage(id)
	if msg.InjectAt != 5678 || msg.DeliveryTransport != "pi-uds-v1" {
		t.Fatalf("updated native snapshot = %+v", msg)
	}
}

func TestResetDeliveringNativeBecomesAccepted(t *testing.T) {
	s := openTestStore(t)
	nativeID, _ := s.AddMessage(Message{ToSession: "native", Body: "native"})
	legacyID, _ := s.AddMessage(Message{ToSession: "legacy", Body: "legacy"})
	if ok, err := s.ClaimNativeMessage(nativeID, "pi-uds-v1", 1234); err != nil || !ok {
		t.Fatalf("claim native = %v, %v", ok, err)
	}
	if err := s.UpdateMessageStatus(legacyID, "delivering", 1, 0, ""); err != nil {
		t.Fatal(err)
	}

	if _, err := s.ResetDelivering(); err != nil {
		t.Fatal(err)
	}
	nativeMsg, _ := s.GetMessage(nativeID)
	if nativeMsg.Status != "accepted" || nativeMsg.InjectAt != 1234 || nativeMsg.DeliveryTransport != "pi-uds-v1" {
		t.Fatalf("native recovery = %+v, want accepted with snapshot", nativeMsg)
	}
	legacyMsg, _ := s.GetMessage(legacyID)
	if legacyMsg.Status != "queued" || legacyMsg.DeliveryTransport != "" {
		t.Fatalf("legacy recovery = %+v, want queued", legacyMsg)
	}
}

func assertNativeSession(t *testing.T, sess Session, transport, instance, endpoint string) {
	t.Helper()
	if sess.DeliveryTransport != transport || sess.DeliveryInstance != instance || sess.DeliveryEndpoint != endpoint {
		t.Fatalf("native session = %q/%q/%q, want %q/%q/%q", sess.DeliveryTransport, sess.DeliveryInstance, sess.DeliveryEndpoint, transport, instance, endpoint)
	}
}
