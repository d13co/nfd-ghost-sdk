import { bytes, Contract, err } from '@algorandfoundation/algorand-typescript'

export class NfdInstanceVthree extends Contract {
  readField(fieldName: bytes): bytes {
    err('stub')
  }
}
