from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class RetrieveStyleRequest(BaseModel):
    topic: str
    discipline: str | None = None
    target_style: str | None = None
    top_k: int = Field(default=3, ge=1, le=20)


class RetrieveSourcesRequest(BaseModel):
    topic: str
    top_k: int = Field(default=6, ge=1, le=30)
    source_type: str | None = None
    citation_role: str | None = None


class GenerateReportRequest(BaseModel):
    topic: str
    word_count: int = Field(default=1600, ge=200, le=20000)
    discipline: str = "general"
    target_style: str = "undergraduate_report"
    requirements: str = ""
    user_points: list[str] = Field(default_factory=list)


class GenerateReportResponse(BaseModel):
    outline: str
    draft: str
    citation_warnings: list[dict[str, Any]]
    similarity_warnings: list[dict[str, Any]]
    style_profiles_used: list[dict[str, Any]]
    sources_used: list[dict[str, Any]]


class CheckCitationsRequest(BaseModel):
    text: str
    sources: list[dict[str, Any] | str] = Field(default_factory=list)


class CheckSimilarityRequest(BaseModel):
    text: str
    style_chunks: list[dict[str, Any] | str] = Field(default_factory=list)
