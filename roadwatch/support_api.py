"""Authenticated, owner-scoped support API. Case access follows Roadwatch's existing workspace policy."""
import asyncio
import time
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from . import auth, store, support

router = APIRouter(prefix="/api/support", tags=["support"])


class MessageInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: str = Field(min_length=1, max_length=2000)
    project_id: str | None = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    page: Literal["welcome", "report", "discussion", "map", "vendor", "evidence", "finances", "observations"] = "welcome"

    @field_validator("message")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("Write a question first")
        return value.strip()


def case_summary(project_id):
    case = store.support_case_summary(project_id) if project_id else None
    if project_id and not case:
        raise HTTPException(404, "Case not found.")
    return case


@router.get("")
def history(request: Request, project_id: str | None = Query(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")):
    user = auth.require(request, "viewer")
    case = case_summary(project_id)
    allowed = support.allowed_actions(user, case)
    turns = store.support_history(user["id"], project_id)
    # Roles can change after a turn was saved; old navigation buttons must respect the current role.
    for turn in turns:
        turn["actions"] = [allowed[a["id"]] for a in turn.get("actions", []) if a["id"] in allowed]
    return {"turns": turns, "mode": "ai" if support.configuration() else "guide",
            "retention_days": support.RETENTION_DAYS, "private": auth.enabled(),
            "case_name": case["name"] if case else None, "project_id": project_id}


@router.post("/message")
async def message(request: Request, data: MessageInput):
    user = auth.require(request, "viewer")
    case = await asyncio.to_thread(case_summary, data.project_id)
    run_id = store.identifier("support")
    stamp = time.time()
    acquired = await asyncio.to_thread(store.support_acquire, user["id"], data.project_id, run_id,
                                       stamp + support.RETENTION_DAYS * 86400, stamp + 60)
    if not acquired:
        raise HTTPException(409, "A reply is already being prepared for this conversation. Please wait.")
    try:
        if not await asyncio.to_thread(store.reserve_support_run, user["id"], support.daily_limit()):
            raise HTTPException(429, "Today's support message limit has been reached. You can still use Roadwatch's normal screens.")
        previous = await asyncio.to_thread(store.support_history, user["id"], data.project_id)
        result = await support.answer(data.message, user, case, data.page, previous)
        current_user = await asyncio.to_thread(auth.current_user, request)
        if not current_user or current_user["id"] != user["id"]:
            raise HTTPException(401, "Your session changed. Sign in again.")
        if current_user["role"] != user["role"]:
            result = support.guide_answer(data.message, current_user, case, bool(support.ai.provider()), previous)
            result["notice"] = "Your permissions changed. Here is guidance for your current role."
        turn = {**result, "id": run_id, "message": data.message, "created_at": store.now(), "project_id": data.project_id}
        # A case deleted while the model was running must not receive a new chat record.
        if data.project_id:
            await asyncio.to_thread(case_summary, data.project_id)
        if not await asyncio.to_thread(store.support_complete, user["id"], data.project_id, run_id, turn):
            raise HTTPException(409, "The conversation was cleared or changed. Please send your question again.")
        return {"turn": turn}
    finally:
        await asyncio.to_thread(store.support_release, user["id"], data.project_id, run_id)


@router.delete("/history")
def clear(request: Request, project_id: str | None = Query(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")):
    user = auth.require(request, "viewer")
    case_summary(project_id)
    store.support_clear(user["id"], project_id)
    return {"cleared": True}
