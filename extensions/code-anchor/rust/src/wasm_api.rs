use std::{cell::RefCell, collections::HashMap};

thread_local! {
    static BUFFERS: RefCell<HashMap<usize, Vec<u8>>> = RefCell::new(HashMap::new());
    static SESSION: RefCell<crate::host_session::HostSession> = RefCell::new(crate::host_session::HostSession::default());
}

fn retain(mut bytes: Vec<u8>) -> u64 {
    let pointer = bytes.as_mut_ptr() as usize;
    let length = bytes.len();
    BUFFERS.with_borrow_mut(|buffers| {
        buffers.insert(pointer, bytes);
    });
    ((pointer as u64) << 32) | length as u64
}

#[unsafe(no_mangle)]
pub extern "C" fn code_anchor_alloc(length: u32) -> u32 {
    let mut bytes = vec![0_u8; length as usize];
    let pointer = bytes.as_mut_ptr() as usize;
    BUFFERS.with_borrow_mut(|buffers| {
        buffers.insert(pointer, bytes);
    });
    pointer as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn code_anchor_free(pointer: u32) {
    BUFFERS.with_borrow_mut(|buffers| {
        buffers.remove(&(pointer as usize));
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn code_anchor_session(pointer: u32) -> u64 {
    let result = BUFFERS
        .with_borrow_mut(|buffers| buffers.remove(&(pointer as usize)))
        .ok_or_else(|| "Unknown request allocation".to_owned())
        .and_then(|bytes| {
            serde_json::from_slice::<crate::host_session::HostRequest>(&bytes)
                .map_err(|error| error.to_string())
        })
        .and_then(|request| SESSION.with_borrow_mut(|session| session.execute(request)));
    let response = match result {
        Ok(value) => serde_json::json!({"ok":true,"value":value}),
        Err(error) => serde_json::json!({"ok":false,"error":error}),
    };
    retain(serde_json::to_vec(&response).expect("Response serialization must succeed"))
}

#[unsafe(no_mangle)]
pub extern "C" fn code_anchor_execute(pointer: u32) -> u64 {
    let request = BUFFERS
        .with_borrow_mut(|buffers| buffers.remove(&(pointer as usize)))
        .ok_or_else(|| "Unknown request allocation".to_owned())
        .and_then(|bytes| {
            serde_json::from_slice::<crate::protocol::Request>(&bytes)
                .map_err(|error| error.to_string())
        });
    let result = request
        .and_then(crate::dispatch)
        .unwrap_or_else(|message| crate::protocol::Response::Error { message });
    retain(serde_json::to_vec(&result).expect("Response serialization must succeed"))
}
