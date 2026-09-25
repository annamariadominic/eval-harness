"""Application settings, read exclusively from environment variables (and an optional .env)."""

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = Field(
        default=f"sqlite+aiosqlite:///{BACKEND_ROOT / 'data' / 'eval_harness.db'}",
        validation_alias="EVAL_HARNESS_DATABASE_URL",
    )
    pricing_file: Path = Field(
        default=BACKEND_ROOT / "pricing.json", validation_alias="EVAL_HARNESS_PRICING_FILE"
    )
    seed_examples: bool = Field(default=True, validation_alias="EVAL_HARNESS_SEED_EXAMPLES")
    cors_origins: list[str] = Field(
        default=["http://localhost:3000"], validation_alias="EVAL_HARNESS_CORS_ORIGINS"
    )

    # Provider credentials. Only ever sourced from the environment.
    openai_api_key: str | None = Field(default=None, validation_alias="OPENAI_API_KEY")
    anthropic_api_key: str | None = Field(default=None, validation_alias="ANTHROPIC_API_KEY")

    # Execution defaults applied when a run does not override them.
    default_concurrency: int = Field(default=4, validation_alias="EVAL_HARNESS_DEFAULT_CONCURRENCY")
    max_concurrency: int = Field(default=32, validation_alias="EVAL_HARNESS_MAX_CONCURRENCY")
    mock_latency_scale: float = Field(
        default=1.0, validation_alias="EVAL_HARNESS_MOCK_LATENCY_SCALE"
    )
    request_timeout_s: float = Field(default=60.0, validation_alias="EVAL_HARNESS_REQUEST_TIMEOUT")

    def resolved_pricing_file(self) -> Path:
        path = self.pricing_file
        return path if path.is_absolute() else BACKEND_ROOT / path


@lru_cache
def get_settings() -> Settings:
    return Settings()
