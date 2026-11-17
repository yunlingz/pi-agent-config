pub mod compat;
pub mod diff_string;
pub mod engine;
pub mod error;
pub mod files;
pub mod fuzzy;
pub mod modes;
pub mod notebook;
pub mod path_policy;
pub mod session;
pub mod store;
pub mod stream_json;
pub mod text;

pub use engine::{
    EditMode, FileOp, FileOpIntent, HeaderKind, Inspection, ModeEngine, PreviewFile, Resolved,
    StagedFile,
};
pub use error::{EditError, EditResult, Rejection};
pub use path_policy::{PathPolicy, UrlResolution};
pub use session::{
    ApplyOutcome, ApplyRequest, EditWriter, FileOutcome, PreviewBatch, Session, WriteRequest,
    WriteResponse,
};
pub use store::EditStore;
pub use stream_json::{ArgSnapshot, ArgStream, EditEntry};
