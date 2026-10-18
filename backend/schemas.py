from typing import Literal
from pydantic import BaseModel, ConfigDict, Field

class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')

class LoginInput(StrictModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=256)

class SourceInput(StrictModel):
    title: str = Field(min_length=1, max_length=160)
    text: str = Field(min_length=10, max_length=50000)

class TaskInput(StrictModel):
    version: int = Field(ge=1)
    node_id: str = Field(max_length=80)
    index: int = Field(ge=0, le=99)
    done: bool

class PreferencesInput(StrictModel):
    target: str | None = Field(default=None, max_length=80)
    goal_text: str | None = Field(default=None, max_length=160)
    navigation_collapsed: bool | None = None
    recents: list[str] | None = Field(default=None, max_length=3)

class ConceptNode(StrictModel):
    title: str = Field(min_length=1, max_length=120)
    aliases: list[str] = Field(default_factory=list, max_length=8)
    kind: Literal['knowledge', 'project'] = 'knowledge'
    layer: int = Field(ge=1, le=4)
    summary: str = Field(min_length=1, max_length=1600)
    concepts: list[tuple[str, str]] = Field(min_length=1, max_length=8)
    tasks: list[str] = Field(min_length=1, max_length=8)
    mistakes: list[tuple[str, str]] = Field(default_factory=list, max_length=6)
    prerequisites: list[str] = Field(default_factory=list, max_length=12)

class Extraction(StrictModel):
    nodes: list[ConceptNode] = Field(min_length=1, max_length=20)

class ApplyInput(StrictModel):
    acknowledge: bool = False

class MentorInput(StrictModel):
    node_id: str = Field(max_length=80)
    question: str = Field(min_length=1, max_length=2000)
