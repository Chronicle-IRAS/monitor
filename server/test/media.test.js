import test from 'node:test'
import assert from 'node:assert/strict'
import { buildFfmpegArgs } from '../src/pipeline.js'
import { AnnexBSplitter, H264KeyframeCache, JpegFramer, nalType } from '../src/media.js'
import { H264_CHUNK, IDR, INTER, PPS, SPS, JPEG_FRAME } from './fake-ffmpeg.js'

function collectNals(splitPoints) {
  const splitter = new AnnexBSplitter()
  const nals = []
  let previous = 0
  for (const point of splitPoints) {
    nals.push(...splitter.push(H264_CHUNK.subarray(previous, point)))
    previous = point
  }
  nals.push(...splitter.push(H264_CHUNK.subarray(previous)))
  // 追加一个伪 NAL，冲刷最后一个被保留的 NAL
  nals.push(...splitter.push(Buffer.from([0, 0, 0, 1, 0x09])))
  return nals
}

test('Annex-B 切分：任意分块边界都能还原 NAL 序列', () => {
  const expected = [SPS, PPS, IDR, INTER]
  const cuts = [[], [1], [3], [4], [5], [7], [8], [12], [H264_CHUNK.length - 1]]

  for (const points of cuts) {
    const nals = collectNals(points)
    assert.deepEqual(nals.slice(0, expected.length), expected, `分块点 ${points} 失败`)
  }
})

test('Annex-B 切分：3 字节起始码同样可识别', () => {
  const splitter = new AnnexBSplitter()
  const stream = Buffer.concat([
    Buffer.from([0, 0, 1, 0x67, 0x42]),
    Buffer.from([0, 0, 1, 0x68, 0x01]),
  ])
  const nals = splitter.push(stream)
  assert.equal(nals.length, 1)
  assert.equal(nalType(nals[0]), 7)
  const rest = splitter.push(Buffer.from([0, 0, 1, 0x65, 0x01]))
  assert.equal(nalType(rest[0]), 8)
})

test('关键帧缓存：保留最近 GOP 的 SPS/PPS/IDR 与后续帧', () => {
  const splitter = new AnnexBSplitter()
  const cache = new H264KeyframeCache()
  for (const nal of splitter.push(H264_CHUNK)) cache.push(nal)
  cache.push(INTER)

  assert.ok(cache.snapshot().equals(Buffer.concat([SPS, PPS, IDR, INTER])))

  cache.push(IDR)
  cache.push(INTER)
  assert.ok(cache.snapshot().equals(Buffer.concat([SPS, PPS, IDR, INTER])))
})

test('JPEG 帧切分：跨分块与多帧连续输出', () => {
  const twoFrames = Buffer.concat([JPEG_FRAME, JPEG_FRAME])
  for (const points of [[4, 9, 14], [1, 2, 3, 13, 20], [JPEG_FRAME.length]]) {
    const framer = new JpegFramer()
    const collected = []
    let previous = 0
    for (const point of points) {
      collected.push(...framer.push(twoFrames.subarray(previous, point)))
      previous = point
    }
    collected.push(...framer.push(twoFrames.subarray(previous)))
    assert.equal(collected.length, 2, `分块点 ${points}`)
    assert.ok(collected[0].equals(JPEG_FRAME))
    assert.ok(collected[1].equals(JPEG_FRAME))
  }
})


test('IDR cache retains every slice of a keyframe', () => {
  const cache = new H264KeyframeCache()
  const secondSlice = Buffer.from([0, 0, 0, 1, 0x65, 0x40])
  for (const nal of [SPS, PPS, IDR, secondSlice, INTER]) cache.push(nal)
  assert.deepEqual(cache.snapshot(), Buffer.concat([SPS, PPS, IDR, secondSlice, INTER]))
})


test('recording arguments survive interrupted writes and have unique prefixes', () => {
  const node = { id: 'camera', udp: 9001, streamType: 'ffmpeg', isRecord: true }
  const config = { recordDir: '/records', segmentSeconds: 60 }
  const first = buildFfmpegArgs(node, config)
  const second = buildFfmpegArgs(node, config)
  assert.ok(first.includes('movflags=+frag_keyframe+empty_moov+default_base_moof'))
  assert.notEqual(first.at(-1), second.at(-1))
})
