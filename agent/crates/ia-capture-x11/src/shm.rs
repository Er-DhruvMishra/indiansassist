//! The MIT-SHM segment the X server writes `ShmGetImage` results into: an anonymous `memfd`,
//! mapped into this process and handed to the server with `ShmAttachFd` (MIT-SHM 1.2, the fd
//! travels over the `RustConnection` socket as `SCM_RIGHTS`). No SysV `shmget` id exists, so
//! nothing outlives the process: the server drops its reference when the segment is detached or
//! the connection closes, and this process's mapping is unmapped on drop.

use std::fs::File;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::ptr::NonNull;

use x11rb::connection::Connection;
use x11rb::protocol::shm::{ConnectionExt as _, Seg};
use x11rb::rust_connection::RustConnection;

pub(crate) struct ShmSegment {
    ptr: NonNull<u8>,
    len: usize,
    seg: Seg,
}

// SAFETY: the mapping is owned by this value alone (no other Rust reference to it exists), so
// moving it to another thread moves the only access path with it.
unsafe impl Send for ShmSegment {}

impl ShmSegment {
    /// Create a `len`-byte segment and attach it to `conn` (the server may write it).
    pub(crate) fn create(conn: &RustConnection, len: usize) -> Result<ShmSegment, String> {
        if len == 0 {
            return Err("empty segment".into());
        }
        // SAFETY: a NUL-terminated name and valid flags; the returned fd is checked below.
        let raw = unsafe { libc::memfd_create(c"ia-capture-x11".as_ptr(), libc::MFD_CLOEXEC) };
        if raw < 0 {
            return Err(format!("memfd_create: {}", std::io::Error::last_os_error()));
        }
        // SAFETY: `raw` is a fresh fd this process owns and nothing else refers to.
        let file = File::from(unsafe { OwnedFd::from_raw_fd(raw) });
        file.set_len(len as u64)
            .map_err(|e| format!("memfd ftruncate: {e}"))?;
        // SAFETY: a fresh shared mapping of a file of exactly `len` bytes; the result is checked.
        let ptr = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                file.as_raw_fd(),
                0,
            )
        };
        if ptr == libc::MAP_FAILED {
            return Err(format!("mmap: {}", std::io::Error::last_os_error()));
        }
        let ptr = NonNull::new(ptr.cast::<u8>()).ok_or("mmap returned null")?;
        // From here on `Drop` unmaps on every error path.
        let mut segment = ShmSegment { ptr, len, seg: 0 };
        segment.seg = conn
            .generate_id()
            .map_err(|e| format!("generate_id: {e}"))?;
        // The fd is sent to the server and closed here once sent; the mapping stays valid.
        conn.shm_attach_fd(segment.seg, OwnedFd::from(file), false)
            .map_err(|e| format!("ShmAttachFd: {e}"))?
            .check()
            .map_err(|e| format!("ShmAttachFd: {e}"))?;
        Ok(segment)
    }

    pub(crate) fn seg(&self) -> Seg {
        self.seg
    }

    pub(crate) fn len(&self) -> usize {
        self.len
    }

    /// The first `len` bytes (clamped to the segment).
    pub(crate) fn bytes_mut(&mut self, len: usize) -> &mut [u8] {
        // SAFETY: the mapping is `self.len` bytes, readable and writable, alive until drop, and
        // `&mut self` makes this the only reference. The server writes it only while a
        // `ShmGetImage` is in flight, and the caller takes this slice after that reply arrived.
        unsafe { std::slice::from_raw_parts_mut(self.ptr.as_ptr(), len.min(self.len)) }
    }

    /// Tell the server to drop the segment (best effort; the connection may be gone).
    pub(crate) fn detach(&self, conn: &RustConnection) {
        let _ = conn.shm_detach(self.seg);
        let _ = conn.flush();
    }
}

impl Drop for ShmSegment {
    fn drop(&mut self) {
        // SAFETY: `ptr` / `len` are exactly the mapping made in `create`, unmapped only here.
        unsafe {
            libc::munmap(self.ptr.as_ptr().cast(), self.len);
        }
    }
}
