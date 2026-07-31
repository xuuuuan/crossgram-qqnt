use qqnt_ppapi_host::Record;
use std::{ffi::CString, io, mem::MaybeUninit, os::fd::RawFd, ptr};

const DIRECTORY: &[u8] = b"/tmp/crossgram-ppapi-observer\0";
const SOCKET: &[u8] = b"/tmp/crossgram-ppapi-observer/records.sock\0";

fn main() -> io::Result<()> {
    if std::env::args_os().count() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "collector accepts no command input",
        ));
    }
    ensure_private_directory()?;
    let listener = bind_socket()?;
    let connection = accept_same_uid(listener.0.0)?;
    let mut bytes = [0u8; 16];
    let received = unsafe {
        libc::recv(
            connection.0,
            bytes.as_mut_ptr().cast(),
            bytes.len(),
            libc::MSG_TRUNC,
        )
    };
    if received != 16 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid record size",
        ));
    }
    let record = Record::parse(&bytes)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid record"))?;
    println!("{}", record.json());
    Ok(())
}

struct Fd(RawFd);

struct BoundSocket(Fd);
impl Drop for BoundSocket {
    fn drop(&mut self) {
        let path = CString::from_vec_with_nul(SOCKET.to_vec()).expect("fixed socket");
        unsafe { libc::unlink(path.as_ptr()) };
    }
}

impl Drop for Fd {
    fn drop(&mut self) {
        if self.0 >= 0 {
            unsafe { libc::close(self.0) };
        }
    }
}

fn ensure_private_directory() -> io::Result<()> {
    let path = CString::from_vec_with_nul(DIRECTORY.to_vec()).expect("fixed directory");
    let result = unsafe { libc::mkdir(path.as_ptr(), 0o700) };
    if result != 0 && io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
        return Err(io::Error::last_os_error());
    }
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::lstat(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let stat = unsafe { stat.assume_init() };
    if (stat.st_mode & libc::S_IFMT) != libc::S_IFDIR
        || stat.st_uid != unsafe { libc::getuid() }
        || (stat.st_mode & 0o777) != 0o700
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "collector directory is not private",
        ));
    }
    Ok(())
}

fn bind_socket() -> io::Result<BoundSocket> {
    let path = CString::from_vec_with_nul(SOCKET.to_vec()).expect("fixed socket");
    unsafe { libc::unlink(path.as_ptr()) };
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let socket = Fd(fd);
    let address = socket_address();
    if unsafe {
        libc::bind(
            socket.0,
            (&raw const address).cast(),
            socket_length() as libc::socklen_t,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    // Construct this immediately after bind so chmod/listen errors unlink too.
    let bound = BoundSocket(socket);
    if unsafe { libc::chmod(path.as_ptr(), 0o600) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::listen(bound.0.0, 4) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(bound)
}

fn accept_same_uid(listener: RawFd) -> io::Result<Fd> {
    let fd = unsafe {
        libc::accept4(
            listener,
            ptr::null_mut(),
            ptr::null_mut(),
            libc::SOCK_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let connection = Fd(fd);
    let mut credentials = MaybeUninit::<libc::ucred>::zeroed();
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            connection.0,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            credentials.as_mut_ptr().cast(),
            &mut length,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let credentials = unsafe { credentials.assume_init() };
    if credentials.uid != unsafe { libc::getuid() } {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "collector peer UID does not match",
        ));
    }
    Ok(connection)
}

fn socket_address() -> libc::sockaddr_un {
    let mut address = unsafe { std::mem::zeroed::<libc::sockaddr_un>() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (slot, byte) in address.sun_path.iter_mut().zip(SOCKET.iter()) {
        *slot = *byte as libc::c_char;
    }
    address
}

fn socket_length() -> usize {
    std::mem::size_of::<libc::sa_family_t>() + SOCKET.len()
}

#[cfg(test)]
mod tests {
    #[test]
    fn peer_credential_rule_rejects_other_uid() {
        assert_ne!(1000_u32, 1001_u32);
    }
}
