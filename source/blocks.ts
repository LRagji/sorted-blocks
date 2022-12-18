import { IAppendStore } from "./i-append-store";
import crc16 from 'crc/calculators/crc16';

export enum CachePolicy {
    Default, //Should only cache indexes
    None, //Clear cache after every call
}

enum SystemBlockTypes {
    Consolidated = 10,
}

export class BufferStore implements IAppendStore {

    private internalBuffer = Buffer.alloc(0);

    public get length() {
        return this.internalBuffer.length;
    }

    constructor(public readonly id: string) { }

    append(data: Buffer): void {
        this.internalBuffer = Buffer.concat([this.internalBuffer, data]);
    }

    reverseRead(fromInclusivePosition: number): Buffer | null {
        throw new Error("Method not implemented.");
    }

    measuredReverseRead(fromInclusivePosition: number, toExclusivePosition: number): Buffer | null {
        throw new Error("Method not implemented.");
    }

}

export class Block {
    public type: number = 0;
    public blockPosition: number = -1;
    public headerLength: number = -1;
    public bodyLength: number = -1;
    public store: IAppendStore | null = null;

    public static from(store: IAppendStore, type: number, blockPosition: number, headerLength: number, bodyLength: number): Block {
        if (store == null) throw new Error(`Parameter "store" cannot be null or undefined.`);
        if (type == null || type < 0 || type > MaxUint32) throw new Error(`Parameter "type" cannot be null or undefined and has to be a in range of 0 to ${MaxUint32}.`);
        if (blockPosition == null || blockPosition < 0) throw new Error(`Parameter "blockPosition" cannot be null or undefined and has to be greater than 0.`);
        if (headerLength == null || headerLength < 0 || headerLength > MaxUint32) throw new Error(`Parameter "headerLength" cannot be null or undefined and has to be a in range of 0 to ${MaxUint32}.`);
        if (bodyLength == null || bodyLength < 0 || bodyLength > MaxUint32) throw new Error(`Parameter "bodyLength" cannot be null or undefined and has to be a in range of 0 to ${MaxUint32}.`);
        const returnObject = new Block();
        returnObject.store = store;
        returnObject.type = type;
        returnObject.blockPosition = blockPosition;
        returnObject.headerLength = headerLength;
        returnObject.bodyLength = bodyLength;
        return returnObject;
    }

    public header(): Buffer {
        return this.store?.measuredReverseRead(this.blockPosition, this.blockPosition - this.headerLength) || Buffer.alloc(0);
    }
    public body(): Buffer {
        return this.store?.measuredReverseRead((this.blockPosition - this.headerLength), this.blockPosition - (this.headerLength + this.bodyLength)) || Buffer.alloc(0);
    }
    public merge(other: Block): Block {
        throw new Error("Method not implemented.");
    }

}
export class SkipBlock extends Block {

    constructor(inclusivePositionFromSkip: bigint, inclusivePositionToSkip: bigint, id: string = Date.now().toString()) {
        super();
        const header = Buffer.alloc(16);
        header.writeBigUint64BE(inclusivePositionFromSkip, 0);
        header.writeBigUint64BE(inclusivePositionToSkip, 8);
        this.store = new BufferStore(id);
        this.store.append(header);
        this.blockPosition = this.store.length;
        this.bodyLength = 0;
        this.headerLength = header.length;
        this.type = SystemBlockTypes.Consolidated;
    }

    public get inclusivePositionFromSkip(): bigint {
        return this.header().readBigUInt64BE(0);
    }

    public get inclusivePositionToSkip(): bigint {
        return this.header().readBigUInt64BE(8);
    }

    public override merge(other: Block): Block {
        throw new Error(`System Block(${this.type}):${this.store?.id} cannot be merged with another Block(${other.type}):${other.store?.id}`);
    }

}

// export interface KVP extends IBlock {
//     version: number,
//     minKey: number,
//     maxKey: number,
//     integrityVerified: boolean,
//     index: Map<bigint, [startIndex: number, endIndex: number]>,
//     get(key: bigint): Buffer
//     iterate(ascending: boolean): IterableIterator<[key: bigint, value: Buffer]>,
//     fromMap(kvps: Map<bigint, Buffer>): KVP
// }

export const MaxUint32 = 4294967295;


export class Blocks {

    public readonly cachedBlocks = new Map<number, Block>();
    private readonly skipPositions = new Array<{ fromPositionInclusive: number, toPositionInclusive: number }>();//Should always be sorted in desc order of position

    private storeReaderPosition: number = -1;
    private storeStartPosition: number = 0;
    private readonly store: IAppendStore;
    private readonly cachePolicy: CachePolicy;
    private readonly systemBlocks = 100;
    private readonly preambleLength = 18;
    public static readonly SOB = Buffer.from("2321", "hex");//#! 35 33
    private static readonly SystemBlockFactory = new Map<number, typeof Block.from>([[SystemBlockTypes.Consolidated, SkipBlock.from]])

    public append(block: Block): number {
        if (block.type > MaxUint32 || block.type < this.systemBlocks) throw new Error(`Block type must be between ${this.systemBlocks} and ${MaxUint32}.`);
        return this.systemBlockAppend(block);
    }

    public * iterate(blockTypeFactory: Map<number, typeof Block.from> | undefined = undefined): Generator<[Block, number]> {
        this.storeReaderPosition = this.positionSkipper(this.store.length - 1);
        let accumulator = Buffer.alloc(0);
        const SOBLastByte = Blocks.SOB[Blocks.SOB.length - 1];
        while (this.storeReaderPosition > this.storeStartPosition) {
            let reverserBuffer = this.store.reverseRead(this.storeReaderPosition);
            if (reverserBuffer == null || reverserBuffer.length === 0) {
                return;
            }
            accumulator = Buffer.concat([reverserBuffer, accumulator.subarray(0, Blocks.SOB.length + 1)]);
            let matchingIndex = accumulator.length;
            do {
                matchingIndex = accumulator.lastIndexOf(SOBLastByte, (matchingIndex - 1))
                if (matchingIndex !== -1
                    && (matchingIndex - (Blocks.SOB.length - 1)) >= 0
                    && Blocks.SOB.reduce((a, e, idx, arr) => a && e === accumulator[matchingIndex - ((arr.length - 1) - idx)], true)) {
                    const absoluteMatchingIndex = (this.storeReaderPosition - (reverserBuffer.length - 1)) + matchingIndex;
                    let block = this.cachedBlocks.get(absoluteMatchingIndex);
                    if (block == null) {
                        //construct & invoke 
                        const preamble = this.store.measuredReverseRead(absoluteMatchingIndex, Math.max(absoluteMatchingIndex - this.preambleLength, this.storeStartPosition));
                        if (preamble == null || preamble.length !== this.preambleLength) {
                            return;
                        }
                        const blockHeaderLength = preamble.readInt32BE(0);
                        const blockBodyLength = preamble.readInt32BE(4);
                        const blockType = preamble.readInt32BE(8);
                        const crc1 = preamble.readUInt16BE(12);
                        const crc2 = preamble.readUInt16BE(14);
                        if (crc1 != crc2 && crc2 != crc16(preamble.subarray(0, 12))) {
                            continue;
                        }
                        //Construct
                        const constructFunction = blockTypeFactory?.get(blockType) || Blocks.SystemBlockFactory.get(blockType) || Block.from;
                        block = constructFunction(this.store, blockType, absoluteMatchingIndex - this.preambleLength, blockHeaderLength, blockBodyLength);
                        if (this.cachePolicy != CachePolicy.None) {
                            this.cachedBlocks.set(absoluteMatchingIndex, block);
                        }
                    }
                    matchingIndex = -1;
                    reverserBuffer = Buffer.alloc(0);
                    accumulator = Buffer.alloc(0);
                    this.storeReaderPosition = (absoluteMatchingIndex - (this.preambleLength + block.headerLength + block.bodyLength));
                    //validate if its system block
                    if (block.type < this.systemBlocks) {
                        this.handleSystemBlock(block);
                    }
                    else {
                        yield ([block, Math.max(this.storeReaderPosition - this.storeStartPosition, this.storeStartPosition)]);
                    }
                }
            }
            while (matchingIndex > 0)
            this.storeReaderPosition -= reverserBuffer.length;
            this.storeReaderPosition = this.positionSkipper(this.storeReaderPosition);
        }
    }

    public consolidate(shouldPurge: (combinedBlock: Block) => boolean = (acc) => false) {
        const cursor = this.iterate();
        let result = cursor.next();
        let accumulator: Block | null = null;
        let lastPurgePosition: number = this.storeReaderPosition;
        let currentBlock: Block | null = null;
        while (!result.done) {
            currentBlock = result.value[0];
            if (accumulator == null) {
                accumulator = currentBlock;
                lastPurgePosition = currentBlock.blockPosition + this.preambleLength;
            }
            else {
                accumulator = currentBlock.merge(accumulator);
            }
            if (shouldPurge(accumulator) === true) {
                this.purgeConsolidatedBlocks(currentBlock, accumulator, lastPurgePosition);
            }
            result = cursor.next();
        }
        if (accumulator != null && currentBlock != null) {
            this.purgeConsolidatedBlocks(currentBlock, accumulator, lastPurgePosition);
        }
    }

    public index() {
        //This indexing the blocks in the file and appends a index block to the store, difference is it does not move or duplicate data like consolidate function.
    }

    constructor(store: IAppendStore, cachePolicy: CachePolicy = CachePolicy.Default) {
        this.store = store;
        this.cachePolicy = cachePolicy;
    }

    private handleSystemBlock(systemBlock: Block): void {
        switch (systemBlock.type) {
            case SystemBlockTypes.Consolidated:
                const castedBlock: SkipBlock = systemBlock as SkipBlock;
                this.skipPositions.push({ fromPositionInclusive: Number(castedBlock.inclusivePositionFromSkip), toPositionInclusive: Number(castedBlock.inclusivePositionToSkip) });
                //Sort the skip positions
                this.skipPositions.sort((a, b) => b.toPositionInclusive - b.toPositionInclusive);
                break;

            default:
                break;
        }
    }

    private positionSkipper(position: number): number {
        return this.skipPositions.reduce((acc, s) => {
            if (s.fromPositionInclusive <= acc && acc >= s.toPositionInclusive) {
                acc = s.toPositionInclusive + 1;
            }
            return acc;
        }, position);
    }

    private systemBlockAppend(block: Block): number {
        const blockBody = block.body();
        const blockHeader = block.header();
        if (blockBody.length > MaxUint32) throw new Error(`Block body size cannot be more than ${MaxUint32}.`);
        if (blockHeader.length > MaxUint32) throw new Error(`Block header size cannot be more than ${MaxUint32}.`);

        const preamble = Buffer.alloc(18);
        preamble.writeUInt32BE(blockHeader.length);
        preamble.writeUInt32BE(blockBody.length, 4);
        preamble.writeUInt32BE(block.type, 8);
        preamble.writeUInt16BE(crc16(preamble.subarray(0, 12)), 12);
        preamble.writeUInt16BE(crc16(preamble.subarray(0, 12)), 14);
        preamble.writeUint8(Blocks.SOB[0], 16);
        preamble.writeUint8(Blocks.SOB[1], 17);
        const finalBuffer = Buffer.concat([blockBody, blockHeader, preamble]);

        this.store.append(finalBuffer);
        return finalBuffer.length;
    }

    private purgeConsolidatedBlocks(currentBlock: Block, accumulator: Block | null, lastPurgePosition: number) {
        const inclusivePositionToSkip = BigInt((currentBlock.blockPosition - (currentBlock.bodyLength + currentBlock.headerLength)) - 1);
        const inclusivePositionFromSkip = BigInt(lastPurgePosition);
        const skip = new SkipBlock(inclusivePositionFromSkip, inclusivePositionToSkip);
        this.append(accumulator as Block);
        this.systemBlockAppend(skip);
        accumulator = null;
        lastPurgePosition = currentBlock.blockPosition - (currentBlock.bodyLength + currentBlock.headerLength);
        this.cachedBlocks.clear();
    }
}
