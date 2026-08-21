import {
  close as closeFileDescriptor,
  constants,
  fstat,
  fsync,
  read,
  write,
  type Stats,
} from 'node:fs'
import { realpath } from 'node:fs/promises'
import { resolve, sep, win32 } from 'node:path'

import koffi from 'koffi'

export type SecureProjectNoteFileStat = {
  identity: string
  isFile: boolean
  size: number
}

export type SecureProjectNoteFile = {
  append(bytes: Buffer): Promise<void>
  close(): Promise<void>
  read(size: number): Promise<Buffer>
  stat(): Promise<SecureProjectNoteFileStat>
  sync(): Promise<void>
}

export type SecureProjectNoteOpenHooks = {
  beforeFinalOpen?: () => Promise<void>
}

export class SecureProjectNoteOpenError extends Error {
  constructor(
    readonly reason: 'access-denied' | 'not-found',
  ) {
    super(reason)
    this.name = 'SecureProjectNoteOpenError'
  }
}

function pathSegments(relativePath: string): string[] {
  const segments = relativePath.split('/')
  if (
    segments.length === 0
    || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\'))
  ) {
    throw new SecureProjectNoteOpenError('access-denied')
  }
  return segments
}

function closeDescriptor(fd: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    closeFileDescriptor(fd, error => error ? reject(error) : resolvePromise())
  })
}

function descriptorStat(fd: number): Promise<Stats> {
  return new Promise((resolvePromise, reject) => {
    fstat(fd, (error, stats) => error ? reject(error) : resolvePromise(stats))
  })
}

function descriptorSync(fd: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    fsync(fd, error => error ? reject(error) : resolvePromise())
  })
}

function descriptorRead(
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    read(fd, buffer, offset, length, position, (error, bytesRead) => (
      error ? reject(error) : resolvePromise(bytesRead)
    ))
  })
}

function descriptorWrite(fd: number, buffer: Buffer, offset: number): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    write(fd, buffer, offset, buffer.length - offset, null, (error, bytesWritten) => (
      error ? reject(error) : resolvePromise(bytesWritten)
    ))
  })
}

class PosixProjectNoteFile implements SecureProjectNoteFile {
  private closed = false

  constructor(private readonly fd: number) {}

  async append(bytes: Buffer): Promise<void> {
    let offset = 0
    while (offset < bytes.length) {
      const written = await descriptorWrite(this.fd, bytes, offset)
      if (written <= 0) throw new SecureProjectNoteOpenError('access-denied')
      offset += written
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await closeDescriptor(this.fd)
  }

  async read(size: number): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      const bytesRead = await descriptorRead(this.fd, buffer, offset, size - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return offset === size ? buffer : buffer.subarray(0, offset)
  }

  async stat(): Promise<SecureProjectNoteFileStat> {
    const stats = await descriptorStat(this.fd)
    return {
      identity: `${stats.dev}:${stats.ino}`,
      isFile: stats.isFile(),
      size: stats.size,
    }
  }

  sync(): Promise<void> {
    return descriptorSync(this.fd)
  }
}

function posixBindings() {
  const libc = koffi.load(null)
  return {
    close: libc.func('close', 'int', ['int']),
    fcntl: libc.func('fcntl', 'int', ['int', 'int', 'int']),
    open: libc.func('open', 'int', ['str', 'int']),
    openat: libc.func('openat', 'int', ['int', 'str', 'int']),
  }
}

function posixOpenError(): SecureProjectNoteOpenError {
  const errno = koffi.errno()
  return new SecureProjectNoteOpenError(
    errno === koffi.os.errno.ENOENT || errno === koffi.os.errno.ENOTDIR
      ? 'not-found'
      : 'access-denied',
  )
}

async function openPosixProjectNoteFile(
  rootPath: string,
  relativePath: string,
  hooks: SecureProjectNoteOpenHooks,
): Promise<SecureProjectNoteFile> {
  const bindings = posixBindings()
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  const canonicalRoot = await realpath(resolve(rootPath))
  const rootSegments = canonicalRoot.split(sep).filter(Boolean)
  const targetSegments = pathSegments(relativePath)
  const parentSegments = targetSegments.slice(0, -1)

  const setCloseOnExec = (fd: number): void => {
    if (bindings.fcntl(fd, 2, 1) === -1) {
      const errno = koffi.errno()
      bindings.close(fd)
      koffi.errno(errno)
      throw posixOpenError()
    }
  }
  const openDirectory = (parentFd: number, segment: string): number => {
    const fd = bindings.openat(parentFd, segment, directoryFlags)
    if (fd === -1) throw posixOpenError()
    setCloseOnExec(fd)
    return fd
  }

  let directoryFd = bindings.open('/', directoryFlags)
  if (directoryFd === -1) throw posixOpenError()
  setCloseOnExec(directoryFd)

  try {
    for (const segment of [...rootSegments, ...parentSegments]) {
      const childFd = openDirectory(directoryFd, segment)
      bindings.close(directoryFd)
      directoryFd = childFd
    }

    await hooks.beforeFinalOpen?.()
    const fileFd = bindings.openat(
      directoryFd,
      targetSegments.at(-1)!,
      constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
    )
    if (fileFd === -1) throw posixOpenError()
    setCloseOnExec(fileFd)
    return new PosixProjectNoteFile(fileFd)
  } finally {
    bindings.close(directoryFd)
  }
}

type NativeHandle = unknown

function createWindowsTypes() {
  const Handle = koffi.pointer('StairProjectNoteHandle', koffi.opaque())
  const UnicodeString = koffi.struct('StairProjectNoteUnicodeString', {
    Length: 'uint16_t',
    MaximumLength: 'uint16_t',
    Buffer: koffi.pointer('uint16_t'),
  })
  const ObjectAttributes = koffi.struct('StairProjectNoteObjectAttributes', {
    Length: 'uint32_t',
    RootDirectory: Handle,
    ObjectName: koffi.pointer(UnicodeString),
    Attributes: 'uint32_t',
    SecurityDescriptor: 'void *',
    SecurityQualityOfService: 'void *',
  })
  const IoStatusValue = koffi.union('StairProjectNoteIoStatusValue', {
    Status: 'int32_t',
    Pointer: 'void *',
  })
  const IoStatusBlock = koffi.struct('StairProjectNoteIoStatusBlock', {
    Value: IoStatusValue,
    Information: 'uintptr_t',
  })
  const StandardInfo = koffi.struct('StairProjectNoteStandardInfo', {
    AllocationSize: 'int64_t',
    EndOfFile: 'int64_t',
    NumberOfLinks: 'uint32_t',
    DeletePending: 'uint8_t',
    Directory: 'uint8_t',
  })
  const AttributeTagInfo = koffi.struct('StairProjectNoteAttributeTagInfo', {
    FileAttributes: 'uint32_t',
    ReparseTag: 'uint32_t',
  })

  return { AttributeTagInfo, Handle, IoStatusBlock, ObjectAttributes, StandardInfo }
}

type WindowsTypes = ReturnType<typeof createWindowsTypes>

let cachedWindowsTypes: WindowsTypes | null = null

function getWindowsTypes(): WindowsTypes {
  cachedWindowsTypes ??= createWindowsTypes()
  return cachedWindowsTypes
}

export function projectNoteWindowsNativeLayoutForTests(): Record<string, number> {
  const types = getWindowsTypes()
  return {
    attributeTagInfo: koffi.sizeof(types.AttributeTagInfo),
    handle: koffi.sizeof(types.Handle),
    ioStatusBlock: koffi.sizeof(types.IoStatusBlock),
    objectAttributes: koffi.sizeof(types.ObjectAttributes),
    standardInfo: koffi.sizeof(types.StandardInfo),
  }
}

function windowsBindings() {
  const kernel32 = koffi.load('kernel32.dll')
  const ntdll = koffi.load('ntdll.dll')
  const { AttributeTagInfo, Handle, IoStatusBlock, ObjectAttributes, StandardInfo } = getWindowsTypes()

  return {
    AttributeTagInfo,
    CloseHandle: kernel32.func('CloseHandle', 'bool', [Handle]),
    CreateFileW: kernel32.func('CreateFileW', Handle, [
      'str16', 'uint32_t', 'uint32_t', 'void *', 'uint32_t', 'uint32_t', Handle,
    ]),
    FlushFileBuffers: kernel32.func('FlushFileBuffers', 'bool', [Handle]),
    GetAttributeTagInfo: kernel32.func('GetFileInformationByHandleEx', 'bool', [
      Handle, 'int', koffi.out(koffi.pointer(AttributeTagInfo)), 'uint32_t',
    ]),
    GetStandardInfo: kernel32.func('GetFileInformationByHandleEx', 'bool', [
      Handle, 'int', koffi.out(koffi.pointer(StandardInfo)), 'uint32_t',
    ]),
    NtCreateFile: ntdll.func('NtCreateFile', 'int32_t', [
      koffi.out(koffi.pointer(Handle)),
      'uint32_t',
      koffi.pointer(ObjectAttributes),
      koffi.out(koffi.pointer(IoStatusBlock)),
      'int64_t *',
      'uint32_t',
      'uint32_t',
      'uint32_t',
      'uint32_t',
      'void *',
      'uint32_t',
    ]),
    ObjectAttributes,
    ReadFile: kernel32.func('ReadFile', 'bool', [
      Handle, 'void *', 'uint32_t', koffi.out(koffi.pointer('uint32_t')), 'void *',
    ]),
    StandardInfo,
    WriteFile: kernel32.func('WriteFile', 'bool', [
      Handle, 'void *', 'uint32_t', koffi.out(koffi.pointer('uint32_t')), 'void *',
    ]),
  }
}

type WindowsBindings = ReturnType<typeof windowsBindings>

let cachedWindowsBindings: WindowsBindings | null = null

function getWindowsBindings(): WindowsBindings {
  cachedWindowsBindings ??= windowsBindings()
  return cachedWindowsBindings
}

function windowsStat(bindings: WindowsBindings, handle: NativeHandle): SecureProjectNoteFileStat {
  const standard = { AllocationSize: 0, EndOfFile: 0, NumberOfLinks: 0, DeletePending: 0, Directory: 0 }
  if (!bindings.GetStandardInfo(
    handle,
    1,
    standard,
    koffi.sizeof(bindings.StandardInfo),
  )) {
    throw new SecureProjectNoteOpenError('access-denied')
  }
  const size = Number(standard.EndOfFile)
  return { identity: 'windows-handle', isFile: standard.Directory === 0, size }
}

function assertWindowsNotReparse(bindings: WindowsBindings, handle: NativeHandle): void {
  const info = { FileAttributes: 0, ReparseTag: 0 }
  if (!bindings.GetAttributeTagInfo(
    handle,
    9,
    info,
    koffi.sizeof(bindings.AttributeTagInfo),
  ) || (info.FileAttributes & 0x400) !== 0) {
    throw new SecureProjectNoteOpenError('access-denied')
  }
}

class WindowsProjectNoteFile implements SecureProjectNoteFile {
  private closed = false

  constructor(
    private readonly bindings: WindowsBindings,
    private readonly handle: NativeHandle,
  ) {}

  async append(bytes: Buffer): Promise<void> {
    let offset = 0
    while (offset < bytes.length) {
      const written = [0]
      const remaining = bytes.subarray(offset)
      if (!this.bindings.WriteFile(this.handle, remaining, remaining.length, written, null) || written[0] <= 0) {
        throw new SecureProjectNoteOpenError('access-denied')
      }
      offset += written[0]
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (!this.bindings.CloseHandle(this.handle)) {
      throw new SecureProjectNoteOpenError('access-denied')
    }
  }

  async read(size: number): Promise<Buffer> {
    if (size === 0) return Buffer.alloc(0)
    const buffer = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      const bytesRead = [0]
      const remaining = buffer.subarray(offset)
      if (!this.bindings.ReadFile(this.handle, remaining, remaining.length, bytesRead, null)) {
        throw new SecureProjectNoteOpenError('access-denied')
      }
      if (bytesRead[0] === 0) break
      offset += bytesRead[0]
    }
    return offset === size ? buffer : buffer.subarray(0, offset)
  }

  async stat(): Promise<SecureProjectNoteFileStat> {
    return windowsStat(this.bindings, this.handle)
  }

  async sync(): Promise<void> {
    if (!this.bindings.FlushFileBuffers(this.handle)) {
      throw new SecureProjectNoteOpenError('access-denied')
    }
  }
}

function windowsInvalidHandle(handle: NativeHandle): boolean {
  if (handle == null) return true
  return BigInt.asIntN(64, koffi.address(handle)) === -1n
}

function openWindowsChild(
  bindings: WindowsBindings,
  parent: NativeHandle,
  segment: string,
  directory: boolean,
): NativeHandle {
  const encodedName = Buffer.from(`${segment}\0`, 'utf16le')
  const unicodeName = {
    Length: encodedName.length - 2,
    MaximumLength: encodedName.length,
    Buffer: encodedName,
  }
  const attributes = {
    Length: koffi.sizeof(bindings.ObjectAttributes),
    RootDirectory: parent,
    ObjectName: unicodeName,
    Attributes: 0x40,
    SecurityDescriptor: null,
    SecurityQualityOfService: null,
  }
  const output = [null]
  const ioStatus = { Value: { Status: 0 }, Information: 0 }
  const desiredAccess = directory
    ? 0x20 | 0x80 | 0x100000
    : 0x1 | 0x4 | 0x80 | 0x100000
  const createOptions = 0x00200000 | 0x20 | (directory ? 0x1 : 0x40)
  const status = bindings.NtCreateFile(
    output,
    desiredAccess,
    attributes,
    ioStatus,
    null,
    0,
    0x7,
    0x1,
    createOptions,
    null,
    0,
  )
  if (status < 0 || output[0] == null) {
    const unsigned = status >>> 0
    const missing = unsigned === 0xc0000034 || unsigned === 0xc000003a
    throw new SecureProjectNoteOpenError(missing ? 'not-found' : 'access-denied')
  }
  const handle = output[0]
  try {
    assertWindowsNotReparse(bindings, handle)
    const stats = windowsStat(bindings, handle)
    if (directory ? stats.isFile : !stats.isFile) {
      throw new SecureProjectNoteOpenError('access-denied')
    }
    return handle
  } catch (error) {
    bindings.CloseHandle(handle)
    throw error
  }
}

async function openWindowsProjectNoteFile(
  rootPath: string,
  relativePath: string,
  hooks: SecureProjectNoteOpenHooks,
): Promise<SecureProjectNoteFile> {
  const bindings = getWindowsBindings()
  const canonicalRoot = await realpath(resolve(rootPath))
  const parsedRoot = win32.parse(canonicalRoot)
  const rootSegments = canonicalRoot.slice(parsedRoot.root.length).split(win32.sep).filter(Boolean)
  const targetSegments = pathSegments(relativePath)
  const rootHandle = bindings.CreateFileW(
    parsedRoot.root,
    0x20 | 0x80 | 0x100000,
    0x7,
    null,
    0x3,
    0x02200000,
    null,
  )
  if (windowsInvalidHandle(rootHandle)) throw new SecureProjectNoteOpenError('access-denied')

  let directoryHandle = rootHandle
  try {
    assertWindowsNotReparse(bindings, directoryHandle)
    if (windowsStat(bindings, directoryHandle).isFile) {
      throw new SecureProjectNoteOpenError('access-denied')
    }
    for (const segment of [...rootSegments, ...targetSegments.slice(0, -1)]) {
      const childHandle = openWindowsChild(bindings, directoryHandle, segment, true)
      bindings.CloseHandle(directoryHandle)
      directoryHandle = childHandle
    }

    await hooks.beforeFinalOpen?.()
    const fileHandle = openWindowsChild(bindings, directoryHandle, targetSegments.at(-1)!, false)
    return new WindowsProjectNoteFile(bindings, fileHandle)
  } finally {
    bindings.CloseHandle(directoryHandle)
  }
}

export async function openProjectNoteFileWithinRoot(
  rootPath: string,
  relativePath: string,
  hooks: SecureProjectNoteOpenHooks = {},
): Promise<SecureProjectNoteFile> {
  return process.platform === 'win32'
    ? openWindowsProjectNoteFile(rootPath, relativePath, hooks)
    : openPosixProjectNoteFile(rootPath, relativePath, hooks)
}
