import pMap from "p-map"
import { chunk } from "./chunk.js"

/**
 * Decorator that automatically chunks array arguments and aggregates results
 * @param chunkSize - The maximum size of each chunk
 * @param chunkArgIndex - The index of the argument to chunk
 * @returns Method decorator
 */
export function chunked(chunkSize: number, chunkArgIndex = 0) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor): PropertyDescriptor {
    const originalMethod = descriptor.value

    descriptor.value = async function (...args: any[]) {
      // If appIds array is smaller than or equal to chunk size, call original method directly
      if (args[chunkArgIndex].length <= chunkSize) {
        // No chunking needed, calling original method directly
        return originalMethod.apply(this, args)
      }
      // read concurrency from 'this' if available
      const concurrency = this && typeof (this as any).concurrency === "number" ? (this as any).concurrency : 2

      // Chunk the appIds array
      const chunks = chunk(args[chunkArgIndex], chunkSize)
      // pMap over chunks with concurrency control. Will be returned in order by pMap.
      const results = await pMap(
        chunks,
        async (chunkedIds) => {
          // reconstruct the arguments with the chunked appIds
          const applyArgs =
            chunkArgIndex === 0
              ? [chunkedIds, ...args.slice(1)]
              : [...args.slice(0, chunkArgIndex), chunkedIds, ...args.slice(chunkArgIndex + 1)]

          return originalMethod.apply(this, applyArgs)
        },
        { concurrency },
      )

      // Flatten the results into a single array
      return results.flat()
    }

    return descriptor
  }
}
