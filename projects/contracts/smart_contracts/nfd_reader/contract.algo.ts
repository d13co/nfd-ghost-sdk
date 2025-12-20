import {
  abimethod,
  Account,
  Application,
  bytes,
  Bytes,
  clone,
  Contract,
  err,
  Global,
  itxn,
  log,
  op,
  uint64,
} from "@algorandfoundation/algorand-typescript";
import { compileArc4, encodeArc4 } from "@algorandfoundation/algorand-typescript/arc4";
import { NfdInstanceVthree } from "../nfd_instance_vthree/contract.algo";

export type NfdNano = {
  name: string;
  asaID: uint64;
  owner: Account;
  version: string;
};

export type NfdTiny = {
  name: string;
  owner: Account;
  caAlgo: Account[];
  unverifiedCaAlgo: Account[];
  version: string;
  expired: boolean;
};

export type AppWithCaBoxHints = {
  appIds: Application[];
  boxHints: {
    hasVerifiedCaAlgoBox: boolean[];
    hasUnverifiedCaAlgoBox: boolean[];
  }
};

export class NfdReader extends Contract {
  @abimethod({ readonly: true, onCreate: "allow" })
  getNamesFromAppIds(appIds: Application[]): string {
    for (const appId of appIds) {
      const [name, exists] = op.AppGlobal.getExBytes(appId, Bytes`i.name`);
      if (exists) {
        log(encodeArc4(name));
      } else {
        log(encodeArc4(""));
      }
    }
    return "";
  }

  @abimethod({ readonly: true, onCreate: "allow" })
  getVersionsFromAppIds(appIds: Application[]): string {
    for (const appId of appIds) {
      const [name, exists] = op.AppGlobal.getExBytes(appId, Bytes`i.name`);
      if (exists) {
        log(encodeArc4(name));
      } else {
        log(encodeArc4(""));
      }
    }
    return "";
  }

  @abimethod({ readonly: true, onCreate: "allow" })
  getNanoViewFromAppIds(appIds: Application[]): NfdNano {
    for (const appId of appIds) {
      const [name, exists] = this.getName(appId);
      if (exists) {
        const nanoView: NfdNano = {
          name: name.toString(),
          asaID: this.getAsaId(appId),
          owner: this.getOwner(appId),
          version: this.getVersion(appId),
        };
        log(encodeArc4(nanoView));
      } else {
        log(encodeArc4(this.getEmptyNfdNano()));
      }
    }
    return this.getEmptyNfdNano();
  }

  private getName(appId: Application): readonly [bytes, boolean] {
    return op.AppGlobal.getExBytes(appId, Bytes`i.name`);
  }

  private getAsaId(appId: Application): uint64 {
    const [asaIdBytes, exists] = op.AppGlobal.getExBytes(appId, Bytes`i.asaid`);
    return exists ? op.btoi(asaIdBytes) : 0;
  }

  private getOwner(appId: Application): Account {
    const [ownerBytes, exists] = op.AppGlobal.getExBytes(appId, Bytes`i.owner.a`);
    return exists ? Account(ownerBytes) : Global.zeroAddress;
  }

  private getVersion(appId: Application): string {
    const [versionBytes, exists] = op.AppGlobal.getExBytes(appId, Bytes`i.ver`);
    return exists ? versionBytes.toString() : "";
  }

  private getMajorVersion(appId: Application): uint64 {
    const [versionBytes, exists] = op.AppGlobal.getExBytes(appId, Bytes`i.ver`);
    return exists ? op.btoi(versionBytes.at(0)) - 48 : 0;
  }

  private getEmptyNfdNano(): NfdNano {
    return {
      name: "",
      asaID: 0,
      owner: Global.zeroAddress,
      version: "",
    } satisfies NfdNano;
  }

  @abimethod({ readonly: true, onCreate: "allow" })
  getTinyViewFromAppIds(appIds: Application[]): NfdTiny {
    for (const appId of appIds) {
      const [name, exists] = this.getName(appId);
      if (exists) {
        const majorVersion = this.getMajorVersion(appId);
        const expired = majorVersion === 3 ? this.getExpired(appId) : false;
        if (majorVersion === 3 && !expired) {
          log(
            encodeArc4({
              name: name.toString(),
              owner: this.getOwner(appId),
              caAlgo: this.getCaAlgo(appId),
              unverifiedCaAlgo: this.getUnverifiedCaAlgo(appId),
              version: this.getVersion(appId),
              expired: false,
            } satisfies NfdTiny)
          );
        } else {
          log(
            encodeArc4({
              name: name.toString(),
              owner: this.getOwner(appId),
              caAlgo: [] as Account[],
              unverifiedCaAlgo: [] as Account[],
              version: this.getVersion(appId),
              expired,
            } satisfies NfdTiny)
          );
        }
      } else {
        log(encodeArc4(this.getEmptyNfdTiny("0")));
      }
    }
    return this.getEmptyNfdTiny("0");
  }

  private getExpired(appId: Application): boolean {
    const [expiredBytes, exists] = op.AppGlobal.getExBytes(appId, Bytes`i.expirationTime`);
    if (exists) {
      const expirationTime = op.btoi(expiredBytes);
      return Global.latestTimestamp >= expirationTime;
    }
    return false;
  }

  @abimethod({ readonly: true, onCreate: "allow" })
  getTinyViewFromAppIdsV2(arg: AppWithCaBoxHints): NfdTiny {
    for (let i: uint64 = 0; i < arg.appIds.length; i++) {
      const appId = arg.appIds[i];
      const hasVerifiedCaAlgoBox = arg.boxHints.hasVerifiedCaAlgoBox[i]
      const hasUnverifiedCaAlgoBox = arg.boxHints.hasUnverifiedCaAlgoBox[i]

      const [name, exists] = this.getName(appId);
      if (exists) {
        const majorVersion = this.getMajorVersion(appId);
        if (majorVersion !== 2) {
          log("ERR:NV2");
          err();
        }
        const tinyView: NfdTiny = {
          name: name.toString(),
          owner: this.getOwner(appId),
          caAlgo: hasVerifiedCaAlgoBox ? this.getCaAlgo(appId) : [],
          unverifiedCaAlgo: hasUnverifiedCaAlgoBox ? this.getUnverifiedCaAlgo(appId) : [],
          version: this.getVersion(appId),
          expired: false,
        };
        log(encodeArc4(tinyView));
      } else {
        log(encodeArc4(this.getEmptyNfdTiny("0")));
      }
    }
    return this.getEmptyNfdTiny("0");
  }

  private getEmptyNfdTiny(version: string): NfdTiny {
    return {
      name: "",
      owner: Global.zeroAddress,
      caAlgo: [],
      unverifiedCaAlgo: [],
      version,
      expired: false,
    } satisfies NfdTiny;
  }

  private getCaAlgo(appId: Application): Account[] {
    return sliceAccounts(this.readField(appId, Bytes`v.caAlgo.0.as`));
  }

  private getUnverifiedCaAlgo(appId: Application): Account[] {
    return sliceAccounts(this.readFieldv2(appId, Bytes`v.unverifiedCaAlgo.0.as`));
  }

  private readField(appId: Application, fieldName: bytes): bytes {
    const version = this.getMajorVersion(appId);
    if (version === 2) return this.readFieldv2(appId, fieldName);
    if (version === 3) return this.readFieldv3(appId, fieldName);
    return Bytes``;
  }

  private readFieldv2(appId: Application, fieldName: bytes): bytes {
    return itxn
      .applicationCall({
        appId: appId,
        appArgs: [Bytes`read_property`, fieldName],
      })
      .submit().lastLog;
  }

  private readFieldv3(appId: Application, fieldName: bytes): bytes {
    return compileArc4(NfdInstanceVthree).call.readField({
      appId,
      args: [fieldName],
    }).returnValue;
  }
}

function sliceAccounts(raw: bytes): Account[] {
  const accounts: Account[] = [];
  for (let i: uint64 = 0; i < raw.length / 32; i++) {
    accounts.push(Account(raw.slice(i * 32, (i + 1) * 32)));
  }
  return accounts;
}
