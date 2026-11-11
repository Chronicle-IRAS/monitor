import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSsOutput,
  parseUnixNetstatOutput,
  parseWindowsNetstatOutput,
} from '../src/ports.js'

test('ss 解析：无 Netid 列的常规输出', () => {
  const tcp = parseSsOutput(
    [
      'LISTEN 0      4096   0.0.0.0:22          0.0.0.0:*',
      'LISTEN 0      511    127.0.0.1:3000      0.0.0.0:*',
      'ESTAB  0      0      10.0.0.2:22         10.0.0.3:50122',
    ].join('\n'),
    'tcp',
  )
  const udp = parseSsOutput('UNCONN 0 0 0.0.0.0:68 0.0.0.0:*\n', 'udp')
  assert.deepEqual(tcp, [22, 3000])
  assert.deepEqual(udp, [68])
})

test('ss 解析：带 Netid 列时仍能定位本地端口', () => {
  const tcp = parseSsOutput(
    [
      'tcp    LISTEN 0      4096   0.0.0.0:22          0.0.0.0:*',
      'tcp    LISTEN 0      511    [::]:9051           [::]:*',
    ].join('\n'),
    'tcp',
  )
  const udp = parseSsOutput('udp    UNCONN 0      0      0.0.0.0:9001      0.0.0.0:*\n', 'udp')
  assert.deepEqual(tcp, [22, 9051])
  assert.deepEqual(udp, [9001])
})

test('netstat 解析：Linux 监听端口', () => {
  const result = parseUnixNetstatOutput(
    [
      'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN',
      'tcp        0      0 10.0.0.2:22             10.0.0.3:50122          ESTABLISHED',
      'udp        0      0 0.0.0.0:9001            0.0.0.0:*',
      'udp6       0      0 :::9051                 :::*',
    ].join('\n'),
  )
  assert.deepEqual(result.tcp, [22])
  assert.deepEqual(result.udp, [9001])
})

test('netstat 解析：Windows 监听行（含非英文状态兜底）', () => {
  const tcp = parseWindowsNetstatOutput(
    [
      '  协议  本地地址          外部地址        状态           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       948',
      '  TCP    0.0.0.0:9051           0.0.0.0:0              ABHÖREN         1234',
      '  TCP    10.0.0.2:50000         93.184.216.34:443      ESTABLISHED     5678',
      '  TCP    0.0.0.0:49670          0.0.0.0:0              TIME_WAIT       0',
    ].join('\n'),
    'TCP',
  )
  const udp = parseWindowsNetstatOutput(
    '  UDP    0.0.0.0:9001           *:*                                    1234\n',
    'UDP',
  )
  assert.deepEqual(tcp, [135, 9051])
  assert.deepEqual(udp, [9001])
})
