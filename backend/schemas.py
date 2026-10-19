from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

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

class SyncTokenInput(StrictModel):
    label: str = Field(min_length=1, max_length=80)
    expiresInDays: int = Field(default=90, ge=1, le=365)

class SyncAgentInfo(StrictModel):
    name: str = Field(min_length=1, max_length=40)
    skill: str = Field(default='', max_length=80)
    skillVersion: str = Field(default='', max_length=20)

class SyncFragment(StrictModel):
    """One authorized excerpt. `ai_summary` marks the absence of the original text."""
    title: str = Field(min_length=1, max_length=160)
    text: str = Field(default='', max_length=50000)
    kind: Literal['user_original', 'ai_summary'] = 'user_original'
    note: str = Field(default='', max_length=300)

    @model_validator(mode='after')
    def original_needs_text(self):
        if self.kind == 'user_original' and len(self.text.strip()) < 10:
            raise ValueError('user_original 片段必须包含至少 10 个字符的原文；只保留摘要时请使用 ai_summary')
        return self

class SyncProjectLink(StrictModel):
    title: str = Field(default='', max_length=120)
    statement: str = Field(default='', max_length=2000)

class SyncItem(StrictModel):
    """A proposed knowledge or project node. Mastery/stage fields are intentionally absent."""
    key: str = Field(min_length=1, max_length=20)
    title: str = Field(min_length=1, max_length=120)
    aliases: list[str] = Field(default_factory=list, max_length=8)
    kind: Literal['knowledge', 'project'] = 'knowledge'
    layer: int = Field(default=1, ge=1, le=4)
    summary: str = Field(min_length=1, max_length=1600)
    concepts: list[tuple[str, str]] = Field(min_length=1, max_length=8)
    tasks: list[str] = Field(min_length=1, max_length=8)
    mistakes: list[tuple[str, str]] = Field(default_factory=list, max_length=6)
    prerequisites: list[str] = Field(default_factory=list, max_length=12)
    understanding: list[str] = Field(default_factory=list, max_length=8)
    openQuestions: list[str] = Field(default_factory=list, max_length=8)
    recommended: list[str] = Field(default_factory=list, max_length=8)
    project: SyncProjectLink | None = None

class SyncPackage(StrictModel):
    """`ko.learning-update` v1: what an agent may submit, and nothing more."""
    format: Literal['ko.learning-update']
    formatVersion: int
    submissionId: str = Field(min_length=8, max_length=80, pattern=r'^[A-Za-z0-9_-]+$')
    baseVersion: int | None = Field(default=None, ge=1)
    createdAt: str = Field(default='', max_length=40)
    sourceType: Literal['agent_skill', 'manual', 'import'] = 'agent_skill'
    scope: str = Field(min_length=1, max_length=500)
    agent: SyncAgentInfo | None = None
    fragments: list[SyncFragment] = Field(min_length=1, max_length=5)
    # 与 Extraction 的 20 条上限保持一致：包在这里就拒收，不要拖到图校验阶段
    # 变成含义模糊的 invalid_relations。
    items: list[SyncItem] = Field(min_length=1, max_length=20)

    @field_validator('formatVersion')
    @classmethod
    def supported_version(cls, value):
        if value != 1:
            raise ValueError('仅支持 formatVersion = 1')
        return value

    @model_validator(mode='after')
    def unique_keys_and_titles(self):
        keys = [item.key for item in self.items]
        if len(set(keys)) != len(keys):
            raise ValueError('items[].key 必须唯一')
        names = [normalize_name(item.title) for item in self.items]
        if len(set(names)) != len(names):
            raise ValueError('items[].title 归一化后必须唯一，同一节点请合并为一条')
        return self

def normalize_name(value):
    import re
    import unicodedata
    return re.sub(r'[^\w\u3400-\u9fff]', '', unicodedata.normalize('NFKC', value).casefold())
