import { Contract } from '@algorandfoundation/algorand-typescript'

export class NfdInstanceVthree extends Contract {
  hello(name: string): string {
    return `Hello, ${name}`
  }
}
