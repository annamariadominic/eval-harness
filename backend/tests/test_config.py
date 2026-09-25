from app.config import BACKEND_ROOT, Settings


def test_relative_sqlite_paths_resolve_from_backend_root() -> None:
    relative = Settings(EVAL_HARNESS_DATABASE_URL="sqlite+aiosqlite:///data/x.db", _env_file=None)
    assert relative.resolved_database_url() == f"sqlite+aiosqlite:///{BACKEND_ROOT / 'data/x.db'}"
    absolute = Settings(EVAL_HARNESS_DATABASE_URL="sqlite+aiosqlite:////tmp/x.db", _env_file=None)
    assert absolute.resolved_database_url() == "sqlite+aiosqlite:////tmp/x.db"
