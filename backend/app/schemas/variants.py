from datetime import datetime
from typing import Any

from pydantic import Field

from app.schemas.common import ApiModel


class VariantFields(ApiModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    provider: str = Field(min_length=1, max_length=50)
    model: str = Field(min_length=1, max_length=200)
    system_prompt: str = ""
    user_template: str = Field(
        min_length=1, description="Prompt template with {{ field }} placeholders."
    )
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int = Field(default=1024, ge=1, le=128_000)
    settings: dict[str, Any] = Field(
        default_factory=dict, description="Provider-specific options passed through verbatim."
    )


class VariantCreate(VariantFields):
    pass


class VariantUpdate(ApiModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    provider: str | None = None
    model: str | None = None
    system_prompt: str | None = None
    user_template: str | None = Field(default=None, min_length=1)
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int | None = Field(default=None, ge=1, le=128_000)
    settings: dict[str, Any] | None = None


class VariantOut(VariantFields):
    id: str
    suite_id: str
    template_variables: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
