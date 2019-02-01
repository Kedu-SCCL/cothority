import ByzCoinRPC from "../byzcoin-rpc";
import Instance, { InstanceID } from "../instance";
import CoinInstance, { Coin } from "./coin-instance";
import Signer from "../../darc/signer";
import DarcInstance from "./darc-instance";
import { Log } from "../../log";
import ClientTransaction, { Instruction, Argument } from "../client-transaction";
import Long from "long";
import CredentialInstance, { CredentialStruct } from "./credentials-instance";
import { PopDesc } from "./pop-party/proto";
import { PopPartyInstance } from "./pop-party/pop-party-instance";
import RoPaSciInstance, { RoPaSciStruct } from "./ro-pa-sci-instance";
import { createHash } from "crypto";
import Proof from "../proof";
import { Point } from "@dedis/kyber";
import Darc from "../../darc/darc";
import IdentityEd25519 from "../../darc/identity-ed25519";
import Rules from "../../darc/rules";
import { Message } from "protobufjs";
import { registerMessage } from "../../protobuf";
import IdentityDarc from "../../darc/identity-darc";

export const SpawnerCoin = Buffer.alloc(32, 0);
SpawnerCoin.write('SpawnerCoin');

export default class SpawnerInstance {
    static readonly contractID = "spawner";

    private rpc: ByzCoinRPC;
    private iid: InstanceID;
    private struct: SpawnerStruct;

    /**
     * Creates a new SpawnerInstance
     * @param {ByzCoinRPC} bc - the ByzCoinRPC instance
     * @param {Instance} iid - the complete instance
     * @param {Spawner} spwaner - parameters for the spawner: costs and names
     */
    constructor(bc: ByzCoinRPC, iid: InstanceID, spawner: SpawnerStruct) {
        this.rpc = bc;
        this.iid = iid;
        this.struct = spawner
    }

    /**
     * Update the data of this instance
     *
     * @return {Promise<SpawnerInstance>} - a promise that resolves once the data
     * is up-to-date
     */
    async update(): Promise<SpawnerInstance> {
        let proof = await this.rpc.getProof(this.iid);
        this.struct = SpawnerStruct.decode(proof.value);
        return this;
    }

    async createUserDarc(coin: CoinInstance, signers: Signer[], pubKey: Point, alias: string): Promise<DarcInstance> {
        let d = SpawnerInstance.prepareUserDarc(pubKey, alias);
        let pr = await this.rpc.getProof(d.baseID);
        if (pr.exists(d.baseID)) {
            Log.lvl2("this darc is already registerd");
            return DarcInstance.fromProof(this.rpc, pr);
        }

        const ctx = new ClientTransaction({
            instructions: [
                Instruction.createInvoke(
                    coin.id,
                    CoinInstance.contractID,
                    "fetch",
                    [new Argument({ name: "coins", value: Buffer.from(this.struct.costDarc.value.toBytesLE()) })],
                ),
                Instruction.createSpawn(
                    this.iid,
                    DarcInstance.contractID,
                    [new Argument({ name: "darc", value: d.toBytes() })],
                ),
            ]
        });
        await ctx.updateCounters(this.rpc, signers);
        ctx.signWith(signers);

        await this.rpc.sendTransactionAndWait(ctx);

        return DarcInstance.fromByzcoin(this.rpc, d.baseID);
    }

    async createCoin(coin: CoinInstance, signers: Signer[], darcID: Buffer, balance: Long = Long.fromNumber(0)): Promise<CoinInstance> {
        let pr = await this.rpc.getProof(SpawnerInstance.coinIID(darcID));
        if (pr.exists(SpawnerInstance.coinIID(darcID))) {
            Log.lvl2("this coin is already registered");
            return CoinInstance.fromProof(this.rpc, pr);
        }

        let valueBuf = this.struct.costCoin.value.add(balance).toBytesLE();
        let ctx = new ClientTransaction({
            instructions: [
                Instruction.createInvoke(
                    coin.id,
                    CoinInstance.contractID,
                    "fetch",
                    [new Argument({ name: "coins", value: Buffer.from(valueBuf) })],
                ),
                Instruction.createSpawn(
                    this.iid,
                    CoinInstance.contractID,
                    [
                        new Argument({ name: "coinName", value: SpawnerCoin }),
                        new Argument({ name: "darcID", value: darcID }),
                    ],
                )
            ]
        });
        await ctx.updateCounters(this.rpc, signers);
        ctx.signWith(signers);

        await this.rpc.sendTransactionAndWait(ctx);

        return CoinInstance.fromByzcoin(this.rpc, SpawnerInstance.coinIID(darcID));
    }

    async createCredential(coin: CoinInstance, signers: Signer[], darcID: Buffer, cred: CredentialStruct): Promise<CredentialInstance> {
        let pr = await this.rpc.getProof(SpawnerInstance.credentialIID(darcID));
        if (pr.exists(SpawnerInstance.credentialIID(darcID))) {
            Log.lvl2("this credential is already registerd");
            return CredentialInstance.fromProof(this.rpc, pr);
        }

        let valueBuf = this.struct.costCredential.value.toBytesLE();
        let ctx = new ClientTransaction({
            instructions: [
                Instruction.createInvoke(
                    coin.id,
                    CoinInstance.contractID,
                    "fetch",
                    [new Argument({ name: "coins", value: Buffer.from(valueBuf) })],
                ),
                Instruction.createSpawn(
                    this.iid,
                    CredentialInstance.contractID,
                    [
                        new Argument({ name: "darcID", value: darcID }),
                        new Argument({ name: "credential", value: cred.toBytes() }),
                    ],
                ),
            ],
        });
        await ctx.updateCounters(this.rpc, signers);
        ctx.signWith(signers);

        await this.rpc.sendTransactionAndWait(ctx);

        return CredentialInstance.fromByzcoin(this.rpc, SpawnerInstance.credentialIID(darcID));
    }

    async createPopParty(coin: CoinInstance, signers: Signer[],
                         orgs: CredentialInstance[],
                         descr: PopDesc, reward: Long):
        Promise<PopPartyInstance> {

        // Verify that all organizers have published their personhood public key
        for (const org of orgs) {
            if (!org.getAttribute('personhood', 'ed25519')) {
                throw new Error(`One of the organisers didn't publish his personhood key`);
            }
        }

        let orgDarcIDs = orgs.map(org => org.darcID);
        let valueBuf = this.struct.costDarc.value.add(this.struct.costParty.value).toBytesLE();
        let orgDarc = SpawnerInstance.preparePartyDarc(orgDarcIDs, "party-darc " + descr.name);
        let ctx = new ClientTransaction({
            instructions: [
                Instruction.createInvoke(
                    coin.id,
                    CoinInstance.contractID,
                    "fetch",
                    [new Argument({ name: "coins", value: Buffer.from(valueBuf) })],
                ),
                Instruction.createSpawn(
                    this.iid,
                    DarcInstance.contractID,
                    [new Argument({ name: "darc", value: orgDarc.toBytes() })],
                ),
                Instruction.createSpawn(
                    this.iid,
                    PopPartyInstance.contractID,
                    [
                        new Argument({ name: "darcID", value: orgDarc.baseID }),
                        new Argument({ name: "description", value: descr.toBytes() }),
                        new Argument({ name: "miningReward", value: Buffer.from(reward.toBytesLE()) }),
                    ],
                )
            ]
        });
        await ctx.updateCounters(this.rpc, signers);
        ctx.signWith(signers);

        await this.rpc.sendTransactionAndWait(ctx);

        return PopPartyInstance.fromByzcoin(this.rpc, ctx.instructions[2].deriveId());
    }

    async createRoPaSci(desc: string, coin: CoinInstance, signer: Signer,
                        stake: Long, choice: number, fillup: Buffer):
        Promise<RoPaSciInstance> {
        if (fillup.length != 31){
            return Promise.reject("need exactly 31 bytes for fillUp");
        }
        let c = new Coin({name: coin.name, value: stake.add(this.struct.costRoPaSci.value) });
        if (coin.value.lessThan(c.value)){
            return Promise.reject("account balance not high enough for that stake");
        }
        let fph = createHash("sha256");
        fph.update(Buffer.from([choice % 3]));
        fph.update(fillup);
        const rps = new RoPaSciStruct({
            description: desc,
            stake: c,
            firstplayerhash: fph.digest(),
            firstplayer: -1,
            secondplayer: -1,
            secondplayeraccount: null,
        });

        const ctx = new ClientTransaction({
            instructions: [
                Instruction.createInvoke(
                    coin.id,
                    CoinInstance.contractID,
                    "fetch",
                    [new Argument({ name: "coins", value: Buffer.from(c.value.toBytesLE()) })]
                ),
                Instruction.createSpawn(
                    this.iid,
                    RoPaSciInstance.contractID,
                    [new Argument({ name: "struct", value: rps.toBytes() })],
                )
            ],
        });
        await ctx.updateCounters(this.rpc, [signer]);
        ctx.signWith([signer]);

        await this.rpc.sendTransactionAndWait(ctx);

        const rpsi = await RoPaSciInstance.fromByzcoin(this.rpc, ctx.instructions[1].deriveId());
        rpsi.setChoice(choice, fillup);

        return rpsi;
    }

    get signupCost(): Long {
        return this.struct.costCoin.value.add(this.struct.costDarc.value).add(this.struct.costCredential.value);
    }

    static async create(bc: ByzCoinRPC, iid: InstanceID, signers: Signer[], costs: CreateCost, beneficiary: InstanceID): Promise<SpawnerInstance> {
        const args = [
            ...Object.keys(costs).map((k) => {
                const value = new Coin({ name: SpawnerCoin, value: costs[k] }).toBytes();
                return new Argument({ name: k, value });
            }),
            new Argument({ name: 'beneficiary', value: beneficiary }),
        ];

        const inst = Instruction.createSpawn(iid, this.contractID, args);
        const ctx = new ClientTransaction({ instructions: [inst] });
        await ctx.updateCounters(bc, signers);
        ctx.signWith(signers);

        await bc.sendTransactionAndWait(ctx);

        return this.fromByzcoin(bc, inst.deriveId());
    }

    static fromProof(bc: ByzCoinRPC, p: Proof): SpawnerInstance {
        if (!p.matches()) {
            throw new Error('fail to get a matching proof');
        }

        return new SpawnerInstance(bc, p.key, SpawnerStruct.decode(p.value));
    }

    /**
     * Initializes using an existing coinInstance from ByzCoin
     * @param bc
     * @param instID
     */
    static async fromByzcoin(bc: ByzCoinRPC, iid: InstanceID): Promise<SpawnerInstance> {
        return SpawnerInstance.fromProof(bc, await bc.getProof(iid));
    }

    static prepareUserDarc(pubKey: Point, alias: string): Darc {
        const id = new IdentityEd25519({ point: pubKey.toProto() });

        const darc = Darc.newDarc([id], [id], Buffer.from(`user ${alias}`));
        darc.addIdentity('invoke:coin.update', id, Rules.AND);
        darc.addIdentity('invoke:coin.fetch', id, Rules.AND);
        darc.addIdentity('invoke:coin.transfer', id, Rules.AND);

        return darc;
    }

    static preparePartyDarc(darcIDs: InstanceID[], desc: string): Darc {
        const ids = darcIDs.map(di => new IdentityDarc({ id: di }));
        const darc = Darc.newDarc(ids, ids, Buffer.from(desc));
        ids.forEach((id) => {
            darc.addIdentity('invoke:popParty.barrier', id, Rules.OR);
            darc.addIdentity('invoke:popParty.finalize', id, Rules.OR);
            darc.addIdentity('invoke:popParty.addParty', id, Rules.OR);
        });

        return darc;
    }

    static credentialIID(darcBaseID: Buffer): InstanceID {
        let h = createHash("sha256");
        h.update(Buffer.from("credential"));
        h.update(darcBaseID);
        return h.digest();
    }

    static coinIID(darcBaseID: Buffer): InstanceID {
        let h = createHash("sha256");
        h.update(Buffer.from("coin"));
        h.update(darcBaseID);
        return h.digest();
    }
}

export class SpawnerStruct extends Message<SpawnerStruct> {
    readonly costdarc: Coin;
    readonly costcoin: Coin;
    readonly costcredential: Coin;
    readonly costparty: Coin;
    readonly costropasci: Coin;
    readonly beneficiary: InstanceID;

    get costDarc(): Coin {
        return this.costdarc;
    }

    get costCoin(): Coin {
        return this.costcoin;
    }

    get costCredential(): Coin {
        return this.costcredential;
    }

    get costParty(): Coin {
        return this.costparty;
    }

    get costRoPaSci(): Coin {
        return this.costropasci;
    }
}

interface CreateCost {
    [k: string]: Long
    costDarc: Long,
    costCoin: Long,
    costCredential: Long,
    costParty: Long,
}

registerMessage('personhood.SpawnerStruct', SpawnerStruct);
