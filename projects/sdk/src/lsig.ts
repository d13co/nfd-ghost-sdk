import { Address, decodeAddress, encodeAddress, LogicSigAccount } from "algosdk"

/**
 * NFD v1's lookup logic sig (`getLookupLSIG` in TxnLab's Go code), version 5:
 *
 * ```
 * intcblock 1; pushbytes <registry id, 8 bytes>; btoi; store 0
 * txn ApplicationID; load 0; ==; txn TypeEnum; pushint 6; ==; &&
 * txn OnCompletion; intc_0; ==; txn OnCompletion; pushint 0; ==; ||; &&
 * bnz label1; err; label1: intc_0; return
 * bytecblock <uvarint length> <suffix>
 * ```
 *
 * The registry id goes at bytes 6–13; the program ends with the `bytecblock` opcode and its count (1), followed by the
 * uvarint length of the suffix and the suffix itself.
 */
const LSIG_TEMPLATE = Uint8Array.from([
  0x05, 0x20, 0x01, 0x01, 0x80, 0x08, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x17, 0x35, 0x00, 0x31, 0x18,
  0x34, 0x00, 0x12, 0x31, 0x10, 0x81, 0x06, 0x12, 0x10, 0x31, 0x19, 0x22, 0x12, 0x31, 0x19, 0x81, 0x00, 0x12, 0x11,
  0x10, 0x40, 0x00, 0x01, 0x00, 0x22, 0x43, 0x26, 0x01,
])
const REGISTRY_ID_OFFSET = 6

const textEncoder = new TextEncoder()

/** The uvarint (LEB128) encoding of `n`, as Go's `binary.PutUvarint`. */
export function uvarint(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`uvarint: ${n} is not a non-negative integer`)
  const out: number[] = []
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80)
    n = Math.floor(n / 0x80)
  }
  out.push(n)
  return Uint8Array.from(out)
}

/** The program of a v1 lookup logic sig for `suffix` under registry `registryAppId`. */
export function lookupLsigProgram(registryAppId: bigint, suffix: Uint8Array): Uint8Array {
  const length = uvarint(suffix.length)
  const program = new Uint8Array(LSIG_TEMPLATE.length + length.length + suffix.length)
  program.set(LSIG_TEMPLATE)
  new DataView(program.buffer).setBigUint64(REGISTRY_ID_OFFSET, registryAppId)
  program.set(length, LSIG_TEMPLATE.length)
  program.set(suffix, LSIG_TEMPLATE.length + length.length)
  return program
}

/** The address of a logic sig: `sha512_256("Program" ‖ program)`. */
export function lsigAddress(program: Uint8Array): string {
  return new LogicSigAccount(program).address().toString()
}

/**
 * The v1 forward lookup account of an NFD name: the logic sig for `name/<name>`, whose local state in the registry
 * holds `i.appid` (and `i.asaid`) when the name is a v1 NFD.
 */
export function nameLsigAddress(registryAppId: bigint, name: string): string {
  return lsigAddress(lookupLsigProgram(registryAppId, textEncoder.encode(`name/${name}`)))
}

/**
 * The v1 reverse lookup account of an address: the logic sig for `address/<base32 address>` (the 58-character string,
 * not the public key), whose local state in the registry holds `i.apps0` … `i.apps15`.
 */
export function addressLsigAddress(registryAppId: bigint, address: string | Address): string {
  // normalizes the address and checks its checksum
  const normalized = encodeAddress(typeof address === "string" ? decodeAddress(address).publicKey : address.publicKey)
  return lsigAddress(lookupLsigProgram(registryAppId, textEncoder.encode(`address/${normalized}`)))
}
