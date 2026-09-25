from app.schemas.common import ApiModel


class ProviderOut(ApiModel):
    name: str
    label: str
    description: str
    configured: bool
    suggested_models: list[str]
    env_var: str | None
