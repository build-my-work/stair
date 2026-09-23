import {
  close as closeFileDescriptor,
  constants,
  fstat,
  fsync,
  read,
  write,
  type Stats,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve, sep, win32 } from 'node:path'

import koffi from 'koffi'

export type SecureProjectNoteFileStat = {
  identity: string
  isFile: boolean
  size: number
  mtimeMs: number
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
    readonly reason: 'access-denied' | 'not-found' | 'already-exists',
  ) {
    super(reason)
    this.name = 'SecureProjectNoteOpenError'
  }
}

type ProjectEntryCreation = { type: 'file' | 'directory'; bytes: Buffer }
  | { type: 'replace'; bytes: Buffer; mode: number }

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
      mtimeMs: stats.mtimeMs,
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
    fchmod: libc.func('fchmod', 'int', ['int', 'uint32_t']),
    open: libc.func('open', 'int', ['str', 'int']),
    openat: libc.func('openat', 'int', ['int', 'str', 'int', '...']),
    mkdirat: libc.func('mkdirat', 'int', ['int', 'str', 'uint32_t']),
    unlinkat: libc.func('unlinkat', 'int', ['int', 'str', 'int']),
    renameat: libc.func('renameat', 'int', ['int', 'str', 'int', 'str']),
  }
}

function posixOpenError(): SecureProjectNoteOpenError {
  const errno = koffi.errno()
  if (errno === koffi.os.errno.EEXIST) return new SecureProjectNoteOpenError('already-exists')
  return new SecureProjectNoteOpenError(
    errno === koffi.os.errno.ENOENT || errno === koffi.os.errno.ENOTDIR
      ? 'not-found'
      : 'access-denied',
  )
}

async function accessPosixProjectFile(
  rootPath: string,
  relativePath: string,
  hooks: SecureProjectNoteOpenHooks,
  creation?: ProjectEntryCreation,
): Promise<SecureProjectNoteFile | null> {
  const bindings = posixBindings()
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  // The caller already authorized this canonical root. Never follow a replacement symlink.
  const canonicalRoot = resolve(rootPath)
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
    const name = targetSegments.at(-1)!
    if (creation?.type === 'directory') {
      if (bindings.mkdirat(directoryFd, name, 0o777) === -1) throw posixOpenError()
      return null
    }
    if (creation?.type === 'replace') {
      const tempName = `.${name}.${randomUUID()}.tmp`
      const fileFd = bindings.openat(directoryFd, tempName,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        'uint32_t', creation.mode)
      if (fileFd === -1) throw posixOpenError()
      try {
        setCloseOnExec(fileFd)
      } catch (error) {
        bindings.unlinkat(directoryFd, tempName, 0)
        throw error
      }
      const file = new PosixProjectNoteFile(fileFd)
      try {
        await file.append(creation.bytes)
        if (bindings.fchmod(fileFd, creation.mode) === -1) throw posixOpenError()
        await file.sync()
        if (bindings.renameat(directoryFd, tempName, directoryFd, name) === -1) throw posixOpenError()
        // Directory fsync is unsupported on some filesystems; rename has already committed.
        await descriptorSync(directoryFd).catch(() => undefined)
        return file
      } catch (error) {
        bindings.unlinkat(directoryFd, tempName, 0)
        await file.close().catch(() => undefined)
        throw error
      }
    }
    const flags = constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW
    const fileFd = creation
      ? bindings.openat(directoryFd, name, flags | constants.O_CREAT | constants.O_EXCL, 'uint32_t', 0o666)
      : bindings.openat(directoryFd, name, flags)
    if (fileFd === -1) throw posixOpenError()
    try {
      setCloseOnExec(fileFd)
    } catch (error) {
      if (creation) bindings.unlinkat(directoryFd, name, 0)
      throw error
    }
    const file = new PosixProjectNoteFile(fileFd)
    if (!creation) return file
    try {
      await file.append(creation.bytes)
      await file.sync()
    } catch (error) {
      bindings.unlinkat(directoryFd, name, 0)
      throw error
    } finally {
      await file.close()
    }
    return null
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
  const BasicInfo = koffi.struct('StairProjectNoteBasicInfo', {
    CreationTime: 'int64_t',
    LastAccessTime: 'int64_t',
    LastWriteTime: 'int64_t',
    ChangeTime: 'int64_t',
    FileAttributes: 'uint32_t',
  })
  const RenameInfo = koffi.struct('StairProjectNoteRenameInfo', {
    ReplaceIfExists: 'uint8_t',
    RootDirectory: Handle,
    FileNameLength: 'uint32_t',
    FileName: koffi.array('uint16_t', 1),
  })

  return { AttributeTagInfo, BasicInfo, Handle, IoStatusBlock, ObjectAttributes, RenameInfo, StandardInfo }
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
    basicInfo: koffi.sizeof(types.BasicInfo),
    handle: koffi.sizeof(types.Handle),
    ioStatusBlock: koffi.sizeof(types.IoStatusBlock),
    objectAttributes: koffi.sizeof(types.ObjectAttributes),
    renameInfo: koffi.sizeof(types.RenameInfo),
    renameFileNameOffset: koffi.offsetof(types.RenameInfo, 'FileName'),
    standardInfo: koffi.sizeof(types.StandardInfo),
  }
}

function windowsBindings() {
  const kernel32 = koffi.load('kernel32.dll')
  const ntdll = koffi.load('ntdll.dll')
  const { AttributeTagInfo, BasicInfo, Handle, IoStatusBlock, ObjectAttributes, RenameInfo, StandardInfo } = getWindowsTypes()

  return {
    AttributeTagInfo,
    BasicInfo,
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
    GetBasicInfo: kernel32.func('GetFileInformationByHandleEx', 'bool', [
      Handle, 'int', koffi.out(koffi.pointer(BasicInfo)), 'uint32_t',
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
    RenameInfo,
    NtSetInformationFile: ntdll.func('NtSetInformationFile', 'int32_t', [
      Handle, koffi.out(koffi.pointer(IoStatusBlock)), 'void *', 'uint32_t', 'int',
    ]),
    ReadFile: kernel32.func('ReadFile', 'bool', [
      Handle, 'void *', 'uint32_t', koffi.out(koffi.pointer('uint32_t')), 'void *',
    ]),
    StandardInfo,
    SetFileDisposition: kernel32.func('SetFileInformationByHandle', 'bool', [
      Handle, 'int', 'void *', 'uint32_t',
    ]),
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
  const basic = { CreationTime: 0, LastAccessTime: 0, LastWriteTime: 0, ChangeTime: 0, FileAttributes: 0 }
  if (!bindings.GetBasicInfo(handle, 0, basic, koffi.sizeof(bindings.BasicInfo))) {
    throw new SecureProjectNoteOpenError('access-denied')
  }
  return {
    identity: 'windows-handle', isFile: standard.Directory === 0, size,
    mtimeMs: Number(BigInt(basic.LastWriteTime) / 10000n) - 11644473600000,
  }
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
  create = false,
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
  const desiredAccess = (directory
    ? 0x20 | 0x80 | 0x100000
    : 0x1 | 0x4 | 0x80 | 0x100000)
    | (create ? 0x10000 : 0)
    // FlushFileBuffers requires GENERIC_WRITE on newly created files.
    | (create && !directory ? 0x40000000 : 0)
  const createOptions = 0x00200000 | 0x20 | (directory ? 0x1 : 0x40)
  const status = bindings.NtCreateFile(
    output,
    desiredAccess,
    attributes,
    ioStatus,
    null,
    0,
    0x7,
    create ? 0x2 : 0x1, // FILE_CREATE fails if the final name already exists.
    createOptions,
    null,
    0,
  )
  if (status < 0 || output[0] == null) {
    const unsigned = status >>> 0
    if (unsigned === 0xc0000035) throw new SecureProjectNoteOpenError('already-exists')
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

async function accessWindowsProjectFile(
  rootPath: string,
  relativePath: string,
  hooks: SecureProjectNoteOpenHooks,
  creation?: ProjectEntryCreation,
): Promise<SecureProjectNoteFile | null> {
  const bindings = getWindowsBindings()
  const canonicalRoot = resolve(rootPath)
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
    if (creation?.type === 'replace') {
      const name = targetSegments.at(-1)!
      const fileHandle = openWindowsChild(bindings, directoryHandle, `.${name}.${randomUUID()}.tmp`, false, true)
      const file = new WindowsProjectNoteFile(bindings, fileHandle)
      try {
        await file.append(creation.bytes)
        await file.sync()
        const encodedName = Buffer.from(name, 'utf16le')
        const nameOffset = koffi.offsetof(bindings.RenameInfo, 'FileName')
        const info = Buffer.alloc(Math.max(koffi.sizeof(bindings.RenameInfo), nameOffset + encodedName.length))
        koffi.encode(info, bindings.RenameInfo, {
          ReplaceIfExists: 1, RootDirectory: directoryHandle,
          FileNameLength: encodedName.length, FileName: [0],
        })
        encodedName.copy(info, nameOffset)
        const ioStatus = { Value: { Status: 0 }, Information: 0 }
        if (bindings.NtSetInformationFile(fileHandle, ioStatus, info, info.length, 10) < 0) {
          throw new SecureProjectNoteOpenError('access-denied')
        }
        return file
      } catch (error) {
        bindings.SetFileDisposition(fileHandle, 4, Buffer.from([1]), 1)
        await file.close().catch(() => undefined)
        throw error
      }
    }
    const fileHandle = openWindowsChild(
      bindings, directoryHandle, targetSegments.at(-1)!, creation?.type === 'directory', !!creation,
    )
    const file = new WindowsProjectNoteFile(bindings, fileHandle)
    if (!creation) return file
    try {
      if (creation.type === 'file') {
        await file.append(creation.bytes)
        await file.sync()
      }
    } catch (error) {
      // Delete the handle we created, even if its parent path has since been replaced.
      bindings.SetFileDisposition(fileHandle, 4, Buffer.from([1]), 1)
      throw error
    } finally {
      await file.close()
    }
    return null
  } finally {
    bindings.CloseHandle(directoryHandle)
  }
}

export async function openProjectNoteFileWithinRoot(
  rootPath: string,
  relativePath: string,
  hooks: SecureProjectNoteOpenHooks = {},
): Promise<SecureProjectNoteFile> {
  const file = process.platform === 'win32'
    ? await accessWindowsProjectFile(rootPath, relativePath, hooks)
    : await accessPosixProjectFile(rootPath, relativePath, hooks)
  return file!
}

/** Create through a pinned parent handle, never by resolving the parent pathname again. */
export async function createProjectEntrySafelyWithinRoot(
  rootPath: string,
  relativePath: string,
  type: 'file' | 'directory',
  initialContent = '',
  hooks: SecureProjectNoteOpenHooks = {},
): Promise<void> {
  const creation = { type, bytes: Buffer.from(initialContent, 'utf8') }
  if (process.platform === 'win32') {
    await accessWindowsProjectFile(rootPath, relativePath, hooks, creation)
  } else {
    await accessPosixProjectFile(rootPath, relativePath, hooks, creation)
  }
}

/** Replace relative to the pinned parent, and read metadata from the committed file handle. */
export async function replaceProjectFileSafelyWithinRoot(
  rootPath: string,
  relativePath: string,
  bytes: Buffer,
  mode: number,
  hooks: SecureProjectNoteOpenHooks = {},
): Promise<SecureProjectNoteFileStat> {
  const creation = { type: 'replace' as const, bytes, mode }
  const file = process.platform === 'win32'
    ? await accessWindowsProjectFile(rootPath, relativePath, hooks, creation)
    : await accessPosixProjectFile(rootPath, relativePath, hooks, creation)
  try {
    return await file!.stat()
  } finally {
    await file!.close()
  }
}
