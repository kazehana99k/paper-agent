from __future__ import annotations

from fastapi import FastAPI

from jstyle_rag.generation.report_pipeline import generate_report
from jstyle_rag.sources.citation_guard import check_citations
from jstyle_rag.sources.source_retriever import retrieve_sources
from jstyle_rag.style.similarity_guard import check_similarity
from jstyle_rag.style.style_retriever import retrieve_abstract_style_advice

from .schemas import (
    CheckCitationsRequest,
    CheckSimilarityRequest,
    GenerateReportRequest,
    GenerateReportResponse,
    RetrieveSourcesRequest,
    RetrieveStyleRequest,
)


app = FastAPI(
    title="Japanese Report Style RAG",
    version="0.1.0",
    description="Local Style RAG API. Style corpus is never used as factual source material.",
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/retrieve-style")
def retrieve_style(request: RetrieveStyleRequest) -> dict[str, object]:
    return {
        "style_profiles": retrieve_abstract_style_advice(
            topic=request.topic,
            discipline=request.discipline,
            target_style=request.target_style,
            top_k=request.top_k,
        )
    }


@app.post("/retrieve-sources")
def retrieve_source_endpoint(request: RetrieveSourcesRequest) -> dict[str, object]:
    return {
        "sources": retrieve_sources(
            request.topic,
            top_k=request.top_k,
            source_type=request.source_type,
            citation_role=request.citation_role,
        )
    }


@app.post("/generate-report", response_model=GenerateReportResponse)
def generate_report_endpoint(request: GenerateReportRequest) -> dict[str, object]:
    result = generate_report(
        topic=request.topic,
        word_count=request.word_count,
        discipline=request.discipline,
        target_style=request.target_style,
        requirements=request.requirements,
        user_points=request.user_points,
    )
    result.pop("prompt", None)
    return result


@app.post("/check-citations")
def check_citations_endpoint(request: CheckCitationsRequest) -> dict[str, object]:
    return check_citations(request.text, request.sources).to_dict()


@app.post("/check-similarity")
def check_similarity_endpoint(request: CheckSimilarityRequest) -> dict[str, object]:
    warnings = check_similarity(request.text, style_chunks=request.style_chunks)
    return {"warnings": [warning.to_dict() for warning in warnings]}
