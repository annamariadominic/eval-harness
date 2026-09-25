from pydantic import BaseModel, ConfigDict


class ApiModel(BaseModel):
    # Fields with defaults are still always present in responses; saying so in the schema gives
    # generated TypeScript types non-optional response fields.
    model_config = ConfigDict(
        from_attributes=True,
        populate_by_name=True,
        json_schema_serialization_defaults_required=True,
    )


def normalize_tags(tags: list[str]) -> list[str]:
    """Trim, lowercase, and de-duplicate tags while preserving order."""
    seen: dict[str, None] = {}
    for tag in tags:
        cleaned = "-".join(tag.strip().lower().split())
        if cleaned:
            seen.setdefault(cleaned, None)
    return list(seen)
