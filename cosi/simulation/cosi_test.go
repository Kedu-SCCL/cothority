package main

import (
	"syscall"
	"testing"
	"time"

	"github.com/dedis/cothority/cosi/crypto"
	"github.com/dedis/kyber/suites"
	"github.com/dedis/onet"
	"github.com/dedis/onet/log"
)

var tSuite = suites.MustFind("Ed25519")

func TestMain(m *testing.M) {
	// Raising the FD limit like this might belong in a more central place,
	// but for the moment, this is the only test where it is biting us.
	// (and even then, only for Jeff's Mac: why?)
	var rLimit syscall.Rlimit
	err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &rLimit)
	if err != nil {
		log.Fatal("Error Getting Rlimit ", err)
	}

	if rLimit.Cur < 2048 {
		rLimit.Cur = 2048
		err = syscall.Setrlimit(syscall.RLIMIT_NOFILE, &rLimit)
		if err != nil {
			log.Fatal("Error Setting Rlimit ", err)
		}
	}

	log.MainTest(m)
}

func TestCoSimul(t *testing.T) {
	for v := 0; v < 3; v++ {
		for _, nbrHosts := range []int{1, 3, 13} {
			log.Lvl2("Running cosi with", nbrHosts, "hosts")
			local := onet.NewLocalTest(tSuite)

			hosts, _, tree := local.GenBigTree(nbrHosts, nbrHosts, 3, true)
			log.Lvl2(tree.Dump())

			done := make(chan bool)
			// create the message we want to sign for this round
			msg := []byte("Hello World Cosi")

			// Register the function generating the protocol instance
			var root *CoSimul
			// function that will be called when protocol is finished by the root
			doneFunc := func(sig []byte) {
				suite := hosts[0].Suite()
				if err := crypto.VerifySignature(suite, root.Publics(), msg, sig); err != nil {
					t.Fatal("error verifying signature:", err)
				} else {
					log.Lvl1("Verification OK")
				}
				done <- true
			}

			// Start the protocol
			p, err := local.CreateProtocol(Name, tree)
			if err != nil {
				t.Fatal("Couldn't create new node:", err)
			}
			root = p.(*CoSimul)
			root.Message = msg
			root.VerifyResponse = VRType(v)
			root.RegisterSignatureHook(doneFunc)
			go root.Start()
			select {
			case <-done:
			case <-time.After(time.Second * 2):
				t.Fatal("Could not get signature verification done in time")
			}
			local.CloseAll()
		}
	}
}
