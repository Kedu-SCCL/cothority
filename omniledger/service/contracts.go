package service

import (
	"encoding/binary"
	"errors"
	"time"

	"github.com/dedis/cothority/omniledger/darc"
	"github.com/dedis/onet/log"
	"github.com/dedis/protobuf"
)

// Here we give a definition of pre-defined contracts.

// ZeroNonce is 32 bytes of zeroes and can have a special meaning.
var ZeroNonce = Nonce([32]byte{})

// OneNonce has 32 bytes of zeros except the LSB is set to one.
var OneNonce = Nonce(func() [32]byte {
	var nonce [32]byte
	nonce[31] = 1
	return nonce
}())

// ZeroDarc is a DarcID with all zeroes.
var ZeroDarc = darc.ID(make([]byte, 32))

// GenesisReferenceID is 64 bytes of zeroes. Its value is a reference to the
// genesis-darc.
var GenesisReferenceID = ObjectID{ZeroDarc, ZeroNonce}

// ContractConfigID denotes a config-contract
var ContractConfigID = "config"

// ContractDarcID denotes a darc-contract
var ContractDarcID = "darc"

// CmdDarcEvolve is needed to evolve a darc.
var CmdDarcEvolve = "Evolve"

// Config stores all the configuration information for one skipchain. It will
// be stored under the key "GenesisDarcID || OneNonce", in the collections. The
// GenesisDarcID is the value of GenesisReferenceID.
type Config struct {
	BlockInterval time.Duration
}

// LoadConfigFromColl loads the configuration data from the collections.
func LoadConfigFromColl(coll CollectionView) (*Config, error) {
	// Find the genesis-darc ID.
	val, contract, err := getValueContract(coll, GenesisReferenceID.Slice())
	if err != nil {
		return nil, err
	}
	if string(contract) != ContractConfigID {
		return nil, errors.New("did not get " + ContractConfigID)
	}
	if len(val) != 32 {
		return nil, errors.New("value has a invalid length")
	}
	// Use the genesis-darc ID to create the config key and read the config.
	configID := ObjectID{
		DarcID:     darc.ID(val),
		InstanceID: OneNonce,
	}
	val, contract, err = getValueContract(coll, configID.Slice())
	if err != nil {
		return nil, err
	}
	if string(contract) != ContractConfigID {
		return nil, errors.New("did not get " + ContractConfigID)
	}
	config := Config{}
	err = protobuf.Decode(val, &config)
	if err != nil {
		return nil, err
	}
	return &config, nil
}

// LoadBlockIntervalFromColl loads the block interval from the collections.
func LoadBlockIntervalFromColl(coll CollectionView) (time.Duration, error) {
	config, err := LoadConfigFromColl(coll)
	if err != nil {
		return defaultInterval, err
	}
	return config.BlockInterval, nil
}

// LoadDarcFromColl loads a darc which should be stored in key.
func LoadDarcFromColl(coll CollectionView, key []byte) (*darc.Darc, error) {
	rec, err := coll.Get(key).Record()
	if err != nil {
		return nil, err
	}
	vs, err := rec.Values()
	if err != nil {
		return nil, err
	}
	if len(vs) < 2 {
		return nil, errors.New("not enough records")
	}
	contractBuf, ok := vs[1].([]byte)
	if !ok {
		return nil, errors.New("can not cast value to byte slice")
	}
	if string(contractBuf) != "darc" {
		return nil, errors.New("expected contract to be darc but got: " + string(contractBuf))
	}
	darcBuf, ok := vs[0].([]byte)
	if !ok {
		return nil, errors.New("cannot cast value to byte slice")
	}
	d, err := darc.NewDarcFromProto(darcBuf)
	if err != nil {
		return nil, err
	}
	return d, nil
}

// ContractConfig can only be instantiated once per skipchain, and only for
// the genesis block.
func (s *Service) ContractConfig(cdb CollectionView, tx Instruction, coins []Coin) (sc []StateChange, c []Coin, err error) {
	if tx.getType() != spawnType {
		return nil, nil, errors.New("Config can only be spawned")
	}
	darcBuf := tx.Spawn.Args.Search("darc")
	d, err := darc.NewDarcFromProto(darcBuf)
	if err != nil {
		log.Error("couldn't decode darc")
		return
	}
	if len(d.Rules) == 0 {
		return nil, nil, errors.New("don't accept darc with empty rules")
	}
	if err = d.Verify(true); err != nil {
		log.Error("couldn't verify darc")
		return
	}

	// sanity check the block interval
	intervalBuf := tx.Spawn.Args.Search("block_interval")
	interval, _ := binary.Varint(intervalBuf)
	if interval == 0 {
		err = errors.New("block interval is zero")
		return
	}

	// create the config to be stored by state changes
	config := Config{
		BlockInterval: time.Duration(interval),
	}
	configBuf, err := protobuf.Encode(&config)
	if err != nil {
		return
	}

	return []StateChange{
		NewStateChange(Create, GenesisReferenceID, ContractConfigID, tx.ObjectID.DarcID),
		NewStateChange(Create, tx.ObjectID, ContractDarcID, darcBuf),
		NewStateChange(Create,
			ObjectID{
				DarcID:     tx.ObjectID.DarcID,
				InstanceID: OneNonce,
			}, ContractConfigID, configBuf),
	}, nil, nil
}

// ContractDarc accepts the following instructions:
//   - Spawn - creates a new darc
//   - Invoke.Evolve - evolves an existing darc
func (s *Service) ContractDarc(coll CollectionView, tx Instruction,
	coins []Coin) ([]StateChange, []Coin, error) {
	if tx.getType() != invokeType {
		return nil, nil, errors.New("Darc can only be invoked (evolved)")
	}
	if tx.Invoke.Command == "evolve" {
		darcBuf := tx.Invoke.Args.Search("darc")
		newD, err := darc.NewDarcFromProto(darcBuf)
		if err != nil {
			return nil, nil, err
		}
		oldD, err := LoadDarcFromColl(coll, ObjectID{newD.BaseID, ZeroNonce}.Slice())
		if err != nil {
			return nil, nil, err
		}
		if err := newD.SanityCheck(oldD); err != nil {
			return nil, nil, err
		}
		return []StateChange{
			NewStateChange(Update, tx.ObjectID, ContractDarcID, darcBuf),
		}, nil, nil
	} else if tx.Invoke.Command == "add" {
		return nil, nil, errors.New("not implemented")
	}
	return nil, nil, errors.New("invalid command: " + tx.Invoke.Command)
}
