import asyncio
import base64
import binascii
import hashlib
import json
import logging
import os
import re
import secrets
import time
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import ai, auth, demo, documents, geocode, opendata, store
from .opendata import geo as _geo
from .analysis import analyze, citation_valid, finding_key
from .models import (EvidenceInput, FinancialInput, ImportInput, InvestigationInput, LocationInput, LoginInput,
                     CommentInput, CommentUpdate, FindingStatusInput, ForgotPassword, InviteAccept, LimitsInput, MemberInput, MemberUpdate,
                     PasswordChange, ProfileUpdate, SignupInput,
                     ObservationInput, OpenDataInput, ProjectInput, SettingsInput, VendorInput)
from .support_api import router as support_router

ROOT = Path(__file__).parent
load_dotenv(ROOT.parent / ".env")  # Never load the unrelated parent project's credentials.
app = FastAPI(title="Roadwatch", version="0.2.0")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
app.include_router(support_router)

GUEST_CLOSED = re.compile(r"/api/(members(/.*)?|me(/.*)?|projects/[^/]+/comments(/.*)?)")
PUBLIC_PATHS = {"/api/login", "/api/guest", "/api/session", "/healthz", "/api/invite/accept", "/api/password/forgot", "/api/signup"}


def meaning_search():
    """The semantic module when search by meaning is configured (MongoDB store plus an embedding model), else None."""
    if not (os.getenv("ROADWATCH_MONGODB_URI") and os.getenv("ROADWATCH_EMBED_MODEL")):
        return None
    from . import semantic
    return semantic if semantic.available() else None


def guest_notice():
    """Members are told their words stay in the workspace; say so when guest access makes that untrue."""
    return " Guest access is on: anyone who has this address can read cases and this discussion without an account." if auth.guest_open() else ""


def daily_ai_limit():
    return int(os.getenv("ROADWATCH_DAILY_AI_LIMIT", "40"))


@app.middleware("http")
async def request_boundary(request: Request, call_next):
    path = request.url.path
    if request.method in {"POST", "PUT", "DELETE", "PATCH"}:
        origin = request.headers.get("origin")
        allowed = {o.strip() for o in os.getenv("ROADWATCH_ALLOWED_ORIGINS", "").split(",") if o.strip()}
        if origin and urlparse(origin).netloc != request.headers.get("host") and origin not in allowed:
            return JSONResponse({"detail": "Cross-origin writes are not allowed."}, status_code=403)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 21_000_000:
                return JSONResponse({"detail": "Request too large. Maximum upload is 15 MB."}, status_code=413)
        request._body = bytes(body)
    request.state.user = auth.current_user(request)
    if path.startswith("/api/") and path not in PUBLIC_PATHS and not path.startswith(("/api/invite/", "/api/verify/")) and auth.enabled():
        if not request.state.user:
            return JSONResponse({"detail": "Sign in required.", "auth": True}, status_code=401)
        if request.state.user["role"] == "guest" and GUEST_CLOSED.fullmatch(path) and not (request.method == "GET" and path == "/api/me"):
            return JSONResponse({"detail": "Guests can work on cases but cannot post in the discussion or manage accounts. Sign in to do that."}, status_code=403)
        if request.method in {"POST", "PUT", "DELETE", "PATCH"} and request.state.user["role"] == "viewer" \
                and not (path.endswith("/comments") or "/comments/" in path or path.endswith("/status") or path == "/api/logout"
                         or path in {"/api/support/message", "/api/support/history"}):
            return JSONResponse({"detail": "Viewers can read and discuss but not change the case. Ask an admin for the investigator role."}, status_code=403)
    response = await call_next(request)
    if path.startswith("/api/support"):
        response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; "
        "img-src 'self' data: https://tile.openstreetmap.org https://*.tile.openstreetmap.org; "
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
    )
    if auth.secure_cookies(request):
        response.headers["Strict-Transport-Security"] = "max-age=31536000"
    return response


def project_or_404(project_id):
    project = store.get_project(project_id)
    if not project:
        raise HTTPException(404, "Case not found.")
    return project


def store_document(project_id, project, *, title, kind, pages, raw, filename, source_url):
    if len(project["evidence"]) >= 100:
        raise HTTPException(422, "A case can hold up to 100 documents.")
    document = {
        "id": store.identifier("evidence"), "title": title, "kind": kind, "source_url": source_url,
        "filename": filename, "sha256": hashlib.sha256(raw).hexdigest(),
        "created_at": store.now(), "pages": pages,
    }
    return store.append_item(project_id, "evidence", document)


def static_version():
    digest = hashlib.sha256()
    for name in ("app.js", "style.css", "support.js", "support.css"):
        digest.update((ROOT / "static" / name).read_bytes())
    return digest.hexdigest()[:10]


@app.get("/")
def index():
    """index.html with a content hash on our own static URLs so browsers never serve a stale app.js/style.css."""
    html = (ROOT / "static" / "index.html").read_text()
    version = static_version()
    html = html.replace('"/static/style.css"', f'"/static/style.css?v={version}"').replace('"/static/app.js"', f'"/static/app.js?v={version}"')
    html = html.replace('"/static/support.css"', f'"/static/support.css?v={version}"').replace('"/static/support.js"', f'"/static/support.js?v={version}"')
    return Response(html, media_type="text/html")


@app.get("/healthz")
def healthz():
    return {"ok": True}


WORKSPACE_RULES = ("You will see and may write statements about named companies and people. Stick to what documents show and cite "
                   "them. Nothing is published outside the workspace, but discussion is sent to the AI provider with each "
                   "investigation. Accounts that post abuse or unsupported accusations can be deactivated by an administrator.")


@app.get("/api/session")
def session(request: Request):
    user = request.state.user
    return {"auth_required": auth.enabled(), "signed_in": user is not None, "user": user,
            "signup_open": auth.enabled() and auth.signup_open(), "signup_role": auth.signup_role(),
            "email_enabled": auth.smtp_configured(), "rules": WORKSPACE_RULES + guest_notice(),
            "accounts": auth.enabled() and user is None and any(m["has_password"] for m in store.members()),
            "guest_open": auth.guest_open()}


@app.post("/api/signup", status_code=201)
def signup(request: Request, data: SignupInput):
    """Open self-registration (ROADWATCH_SIGNUP=open). With SMTP the account must confirm its email first."""
    if not auth.enabled():
        raise HTTPException(422, "Sign-in is not enabled on this server.")
    if not data.accept_rules:
        raise HTTPException(422, "Please accept the workspace rules.")
    needs_verification = auth.smtp_configured()
    member, code = auth.register(request, data.name, data.email, data.password, needs_verification)
    if needs_verification:
        try:
            auth.send_mail(member["email"], "Confirm your Roadwatch account",
                           f"Hello {member['name']},\n\nConfirm your email by opening this link within {auth.INVITE_HOURS} hours:\n"
                           f"{invite_link(request, code).replace('#invite=', '#verify=')}\n\nIf you did not sign up, ignore this message.")
        except Exception:
            store.update_member(member["id"], verified=1, invite_hash=None, invite_expires=None)  # mail failed: do not strand the person
            needs_verification = False
    if needs_verification:
        return {"signed_in": False, "pending_verification": True, "message": "Check your email for a confirmation link."}
    return signed_in_response(request, auth.public(store.member(member["id"])), status_code=201)


@app.get("/api/verify/{code}")
def verify(request: Request, code: str):
    return signed_in_response(request, auth.verify_email(code))


def signed_in_response(request, user, status_code=200):
    response = JSONResponse({"signed_in": True, "user": user}, status_code=status_code)
    response.set_cookie(auth.COOKIE, auth.issue_token(user), max_age=auth.SESSION_DAYS * 86400,
                        httponly=True, samesite="lax", secure=auth.secure_cookies(request))
    return response


@app.post("/api/login")
def login(request: Request, data: LoginInput):
    if not auth.enabled():
        return {"signed_in": True, "user": auth.LOCAL}
    if data.email and data.password:
        return signed_in_response(request, auth.check_password_login(request, data.email, data.password))
    if not data.access_key:
        raise HTTPException(422, "Enter your email and password, or an access key.")
    return signed_in_response(request, auth.check_login(request, data.access_key))


@app.post("/api/guest")
def enter_as_guest(request: Request):
    """Read-only entry without an account, when ROADWATCH_GUEST=on."""
    if not auth.guest_open():
        raise HTTPException(403, "Guest access is not enabled on this server.")
    return signed_in_response(request, dict(auth.GUEST))


def invite_link(request: Request, code: str):
    base = os.getenv("ROADWATCH_PUBLIC_URL", "").rstrip("/") or str(request.base_url).rstrip("/")
    return f"{base}/#invite={code}"


@app.post("/api/invite/accept")
def accept_invite(request: Request, data: InviteAccept):
    if not auth.enabled():
        raise HTTPException(422, "Sign-in is not enabled on this server.")
    return signed_in_response(request, auth.accept_invite(request, data.code, data.password))


@app.get("/api/invite/{code}")
def invite_preview(code: str):
    """Who the invite is for, so the set-password screen can greet them. Reveals nothing else."""
    found = store.member_by_invite_hash(auth.hash_key("invite:" + code))
    if not found or not found.get("invite_expires") or int(found["invite_expires"]) < time.time():
        raise HTTPException(410, "This invite link is invalid or has expired. Ask the admin for a new one.")
    return {"name": found["name"], "email": found.get("email"), "role": found["role"], "reset": bool(found.get("password_hash"))}


@app.post("/api/password/forgot")
def forgot_password(request: Request, data: ForgotPassword):
    """Always answers the same way. Emails a reset link when SMTP is configured; otherwise the admin issues one."""
    if auth.enabled() and auth.smtp_configured():
        found = store.member_by_email(data.email.strip())
        if found and found["active"]:
            code, digest, expires = auth.new_invite()
            store.update_member(found["id"], invite_hash=digest, invite_expires=expires)
            try:
                auth.send_mail(found["email"], "Roadwatch password reset",
                               f"Hello {found['name']},\n\nOpen this link within {auth.INVITE_HOURS} hours to set a new password:\n{invite_link(request, code)}\n\n"
                               "If you did not ask for this, ignore this message.")
            except Exception:
                pass
        return {"ok": True, "message": "If that address belongs to an account, a reset link has been emailed."}
    return {"ok": True, "message": "This server does not send email. Ask your administrator for a reset link. If you are the "
                                   "administrator, choose \"Use an access key instead\" and sign in with the server's access key."}


@app.get("/api/me")
def me(request: Request):
    return request.state.user


@app.put("/api/me")
def update_me(request: Request, data: ProfileUpdate):
    user = request.state.user
    if user["id"] in ("admin", "local"):
        raise HTTPException(422, "The bootstrap administrator has no profile; create an admin account for yourself in Team & access.")
    return auth.public(store.member(store.update_member(user["id"], name=data.name.strip())["id"]))


@app.put("/api/me/password")
def change_my_password(request: Request, data: PasswordChange):
    user = request.state.user
    if user["id"] in ("admin", "local"):
        raise HTTPException(422, "The bootstrap administrator signs in with ROADWATCH_ACCESS_KEY; change it in the server configuration.")
    auth.change_password(user["id"], data.current_password, data.new_password)
    return signed_in_response(request, auth.public(store.member(user["id"])))


@app.get("/api/members")
def list_members(request: Request):
    return {"members": store.members(include_inactive=request.state.user["role"] == "admin"), "roles": list(auth.ROLES)}


@app.post("/api/members", status_code=201)
def add_member(request: Request, data: MemberInput):
    """Create an account and return its invite link (shown once). The person sets their own password from it."""
    auth.require(request, "admin")
    if not auth.enabled():
        raise HTTPException(422, "Set ROADWATCH_ACCESS_KEY first: accounts only make sense when sign-in is on.")
    if store.member_by_email(data.email):
        raise HTTPException(409, "An account with that email already exists.")
    code, digest, expires = auth.new_invite()
    member = store.add_member(data.name, data.role, auth.hash_key(auth.new_member_key()), email=data.email.strip().lower(),
                              invite_hash=digest, invite_expires=expires)
    emailed = False
    if auth.smtp_configured():
        try:
            auth.send_mail(member["email"], "You have been invited to Roadwatch",
                           f"Hello {member['name']},\n\n{request.state.user['name']} invited you to a Roadwatch workspace as {member['role']}. "
                           f"Open this link within {auth.INVITE_HOURS} hours to set your password:\n{invite_link(request, code)}")
            emailed = True
        except Exception:
            emailed = False
    return {**member, "invite_link": invite_link(request, code), "emailed": emailed}


@app.put("/api/members/{member_id}")
def update_member(request: Request, member_id: str, data: MemberUpdate):
    auth.require(request, "admin")
    if not store.member(member_id):
        raise HTTPException(404, "Member not found.")
    fields = {k: v for k, v in (("role", data.role), ("active", None if data.active is None else int(data.active))) if v is not None}
    if data.active is False:
        fields["token_salt"] = secrets.token_hex(8)  # ends their sessions now
    extra = {}
    if data.reset_key:
        key = auth.new_member_key()
        fields["key_hash"] = auth.hash_key(key)
        extra["key"] = key
    if data.reset_password:
        code, digest, expires = auth.new_invite()
        fields.update(invite_hash=digest, invite_expires=expires, token_salt=secrets.token_hex(8))
        extra["invite_link"] = invite_link(request, code)
    updated = store.update_member(member_id, **fields)
    return {**updated, **extra}


@app.post("/api/logout")
def logout():
    response = JSONResponse({"signed_in": False})
    response.delete_cookie(auth.COOKIE)
    return response


@app.get("/api/config")
def config():
    limit = daily_ai_limit()
    meaning = meaning_search()
    if meaning:
        meaning.start()
    return {**ai.configuration(), "daily_ai_limit": limit, "ai_runs_today": store.ai_runs_today(),
            "import_hosts": sorted(documents.ALLOWED_HOSTS), "semantic_search": bool(meaning),
            "embedding_model": meaning.settings()["model"] if meaning else ""}


@app.get("/api/projects")
def projects():
    return store.project_summaries()


@app.get("/api/search")
def search_cases(q: str, mode: str = "words"):
    """Evidence pages in any case that contain every word of the query, or (mode=meaning) the pages closest to it in meaning."""
    if not 2 <= len(q.strip()) <= 200:
        raise HTTPException(422, "Enter at least two characters to search.")
    if mode == "meaning":
        meaning = meaning_search()
        if not meaning:
            raise HTTPException(422, "Search by meaning needs the MongoDB store and an embedding model (ROADWATCH_EMBED_MODEL).")
        try:
            hits = meaning.search(q.strip(), limit=15)
        except Exception as error:
            logging.getLogger("roadwatch").warning("search by meaning failed: %s", type(error).__name__)
            raise HTTPException(502, "Search by meaning is unavailable right now. Search by exact words still works.")
        meaning.start()
        return {"query": q.strip(), "mode": "meaning", "hits": hits, "truncated": False, "indexing": meaning.status()["pending"]}
    hits = store.search_evidence(q.strip(), limit=41)
    return {"query": q.strip(), "mode": "words", "hits": hits[:40], "truncated": len(hits) > 40}


@app.get("/api/provinces")
def provinces():
    """Provincial tiers a supplier case can add (each also brings its largest city's records)."""
    return [{k: p[k] for k in ("key", "name", "city_name", "tiers")} for p in opendata.vendor.PROVINCES.values()]


def check_city(location):
    if location and location.city_key not in opendata.CITIES:
        raise HTTPException(422, "Open data is not connected for this city yet. Supported: "
                                 + ", ".join(m.NAME for m in opendata.CITIES.values()) + ".")


def same_street(a, b):
    return a["city_key"] == b["city_key"] and a["road"].casefold() == b["road"].casefold()


def add_location(project, location):
    if any(same_street(existing, location) for existing in project["locations"]):
        raise HTTPException(409, f"{location['road']} is already part of this case.")
    if len({l["city_key"] for l in project["locations"]} | {location["city_key"]}) > 1:
        raise HTTPException(422, "All streets in a case must be in the same city so their open data can be merged.")
    if len(project["locations"]) >= 12:
        raise HTTPException(422, "A case can hold up to 12 streets.")
    project["locations"].append(location)


@app.post("/api/projects", status_code=201)
def create_project(data: ProjectInput):
    fields = data.model_dump(mode="json")
    aliases, province = fields.pop("vendor_aliases"), fields.pop("province")
    if data.anchor == "vendor":
        fields["vendor"] = {"name": data.contractor, "aliases": aliases, "province": province}
        fields["locations"] = []
        return store.create_project(fields)
    locations, fields["locations"] = fields["locations"], []
    for location in data.locations:
        check_city(location)
    for location in locations:
        add_location(fields, location)
    return store.create_project(fields)


@app.put("/api/projects/{project_id}/vendor")
def update_vendor(project_id: str, data: VendorInput):
    """Rename the supplier, add other names it trades under, or choose the province; pull again afterwards."""
    project = project_or_404(project_id)
    if project.get("anchor") != "vendor":
        raise HTTPException(422, "This case follows streets, not a supplier.")

    def update(current):
        current["vendor"] = {"name": data.name, "aliases": data.aliases, "province": data.province}
        current["contractor"] = data.name
        current["revision"] += 1
    return store.mutate(project_id, update)


@app.post("/api/demo", status_code=201)
def create_demo():
    return demo.seed()


@app.get("/api/projects/{project_id}")
def get_project(project_id: str):
    return project_or_404(project_id)


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str):
    if not store.delete_project(project_id):
        raise HTTPException(404, "Case not found.")
    return {"deleted": project_id}


@app.post("/api/projects/{project_id}/evidence", status_code=201)
def add_evidence(project_id: str, data: EvidenceInput):
    project = project_or_404(project_id)
    if data.file_base64:
        try:
            raw = base64.b64decode(data.file_base64, validate=True)
        except (ValueError, binascii.Error):
            raise HTTPException(422, "Invalid file encoding.")
        pages = documents.pages_from_bytes(raw, filename=data.filename)
    else:
        raw = data.text.encode()
        if not data.text.strip():
            raise HTTPException(422, "Paste the document text or upload a file.")
        pages = [{"number": 1, "text": data.text}]
    return store_document(project_id, project, title=data.title, kind=data.kind, pages=pages, raw=raw,
                          filename=data.filename, source_url=str(data.source_url) if data.source_url else None)


@app.post("/api/projects/{project_id}/evidence/import", status_code=201)
async def import_evidence(project_id: str, data: ImportInput):
    project = project_or_404(project_id)
    raw, filename, content_type, final_url = await documents.fetch_official(str(data.url))
    pages = documents.pages_from_bytes(raw, filename=filename, content_type=content_type)
    title = data.title.strip() or (pages[0]["text"].strip().splitlines() or [filename])[0][:120] or filename
    return store_document(project_id, project, title=title, kind=data.kind, pages=pages, raw=raw,
                          filename=filename, source_url=final_url)


@app.post("/api/projects/{project_id}/finances", status_code=201)
def add_financial(project_id: str, data: FinancialInput):
    project = project_or_404(project_id)
    entry = data.model_dump(mode="json")
    if data.kind != "amendment" and data.amount <= 0:
        raise HTTPException(422, "Award and payment amounts must be positive.")
    if not citation_valid(entry, project):
        raise HTTPException(422, "The quotation must match text on the selected evidence page.")
    entry.update(id=store.identifier("entry"), amount=f"{data.amount:.2f}")

    def insert(current):
        if not citation_valid(entry, current):
            raise HTTPException(409, "The source changed. Refresh the case.")
        current["finances"].append(entry)
        current["revision"] += 1
    return store.mutate(project_id, insert)


@app.post("/api/projects/{project_id}/observations", status_code=201)
def add_observation(project_id: str, data: ObservationInput):
    project_or_404(project_id)
    return store.append_item(project_id, "observations", {
        **data.model_dump(mode="json"), "id": store.identifier("observation"),
    })


@app.get("/api/cities")
def list_cities():
    return geocode.cities()


_condition_cache = {}


def condition_index(city_key):
    """Parsed condition layer per city, kept in memory for a day with a bbox per feature."""
    module = opendata.CITIES[city_key]
    cached = _condition_cache.get(city_key)
    if cached and time.time() - cached["at"] < 86400:
        return cached
    layer = module.condition_layer()
    boxes = [_geo.bbox_of(f["geometry"]) for f in layer["features"]]
    _condition_cache[city_key] = {"at": time.time(), "layer": layer, "boxes": boxes}
    return _condition_cache[city_key]


@app.get("/api/condition")
async def condition(city: str, bbox: str):
    """Road-condition features intersecting a west,south,east,north viewport."""
    if city not in opendata.CITIES:
        raise HTTPException(404, "Unknown city.")
    try:
        west, south, east, north = (float(v) for v in bbox.split(","))
    except ValueError:
        raise HTTPException(422, "bbox must be west,south,east,north.")
    if (east - west) * (north - south) > 0.02:
        raise HTTPException(422, "Zoom in to see road condition.", headers={"X-Roadwatch-Zoom": "1"})
    try:
        index = await asyncio.to_thread(condition_index, city)
    except Exception as error:
        logging.getLogger("roadwatch").warning("condition layer failed for %s: %r", city, error)
        raise HTTPException(502, "The city's road-condition data could not be downloaded right now.")
    view = (west, south, east, north)
    features = [f for f, box in zip(index["layer"]["features"], index["boxes"]) if _geo.intersects(box, view)]
    return {"type": "FeatureCollection", "features": features[:4000], "legend": index["layer"]["legend"],
            "truncated": len(features) > 4000}


@app.get("/api/geocode")
async def geocode_search(q: str, city: str | None = None):
    if not 2 <= len(q.strip()) <= 200:
        raise HTTPException(422, "Enter a street name to search.")
    return await geocode.search(q.strip(), city=city)


@app.get("/api/geocode/reverse")
async def geocode_reverse(lat: float, lon: float):
    return await geocode.reverse(lat, lon)


@app.put("/api/projects/{project_id}/settings")
def update_settings(project_id: str, data: SettingsInput):
    project_or_404(project_id)

    def update(project):
        project["show_condition"] = data.show_condition
    return store.mutate(project_id, update)


@app.post("/api/projects/{project_id}/locations", status_code=201)
def add_street(project_id: str, data: LocationInput):
    project_or_404(project_id)
    check_city(data)
    return store.mutate(project_id, lambda project: add_location(project, data.model_dump(mode="json")))


@app.put("/api/projects/{project_id}/locations/{index}")
def update_street(project_id: str, index: int, data: LimitsInput):
    project_or_404(project_id)

    def update(project):
        if not 0 <= index < len(project["locations"]):
            raise HTTPException(404, "Street not found.")
        project["locations"][index].update(from_street=data.from_street.strip(), to_street=data.to_street.strip())
    return store.mutate(project_id, update)


@app.delete("/api/projects/{project_id}/locations/{index}")
def remove_street(project_id: str, index: int):
    project_or_404(project_id)

    def update(project):
        if not 0 <= index < len(project["locations"]):
            raise HTTPException(404, "Street not found.")
        project["locations"].pop(index)
    return store.mutate(project_id, update)


@app.post("/api/projects/{project_id}/open-data")
async def pull_open_data(project_id: str, data: OpenDataInput):
    project = project_or_404(project_id)
    locations = project.get("locations") or []
    if project.get("anchor") == "vendor":
        vendor = project.get("vendor") or {}
        names = opendata.vendor.names_of(vendor)
        if not names:
            raise HTTPException(422, "Enter the supplier's name first.")
        province = opendata.vendor.PROVINCES.get(vendor.get("province") or "")
        streets, limits, scope = [], {}, {"city_key": vendor.get("province") or None, "vendor_names": names,
                                         "city": "Government of Canada" + (f", {province['name']} and {province['city_name']}" if province else "")}
        pull = lambda: opendata.vendor.profile(names, vendor.get("province") or "", data.since_year)
    else:
        if not locations:
            raise HTTPException(422, "Choose at least one street on the map first.")
        city = opendata.CITIES[locations[0]["city_key"]]
        streets = [l["road"] for l in locations]
        limits = {l["road"]: [l.get("from_street", ""), l.get("to_street", "")] for l in locations if l.get("from_street") or l.get("to_street")}
        scope = {"city_key": city.KEY, "city": city.NAME}
        pull = lambda: city.profile(streets, data.since_year)
    try:
        results, errors = await asyncio.wait_for(asyncio.to_thread(pull), timeout=240)
    except asyncio.TimeoutError:
        raise HTTPException(504, "The open data portal is slow right now. Try again in a few minutes.")
    for result in results:
        opendata.flag_limits(result["records"], limits)
    documents_out = []
    for result in results:
        raw = json.dumps(result["records"], sort_keys=True, default=str).encode()
        documents_out.append({
            "id": store.identifier("evidence"), "title": result["title"], "kind": "open_data",
            "source_url": result["source_url"], "filename": "", "sha256": hashlib.sha256(raw).hexdigest(),
            "created_at": store.now(), "pages": result["pages"], "dataset": result["key"],
        })
    pulled_at = store.now()

    def update(current):
        kept = [d for d in current["evidence"] if d.get("dataset") is None]
        if len(kept) + len(documents_out) > 100:
            raise HTTPException(422, "A case can hold up to 100 documents.")
        referenced = {r["evidence_id"] for r in current["finances"]}
        if any(d.get("dataset") and d["id"] in referenced for d in current["evidence"]):
            raise HTTPException(409, "Remove financial entries that cite earlier open-data documents first.")
        current["evidence"] = kept + documents_out
        current["open_data"] = [{
            "key": r["key"], "title": r["title"], "source_url": r["source_url"], "evidence_id": d["id"],
            "count": len(r["records"]), "records": r["records"][:400], "summary": r.get("summary"),
            "total": r.get("total", len(r["records"])), "pulled_at": pulled_at, "baselines": r.get("baselines"), "since_year": data.since_year, "streets": streets,
            **scope, "errors": errors,
        } for r, d in zip(results, documents_out)]
        current["revision"] += 1
    return store.mutate(project_id, update)


@app.delete("/api/projects/{project_id}/{collection}/{item_id}")
def delete_item(request: Request, project_id: str, collection: str, item_id: str):
    if collection == "comments":  # declared earlier than the comment routes, so dispatch explicitly
        return remove_comment(request, project_id, item_id)
    project_or_404(project_id)
    if collection not in {"evidence", "finances", "observations"}:
        raise HTTPException(404, "Collection not found.")

    def remove(project):
        if not any(item["id"] == item_id for item in project[collection]):
            raise HTTPException(404, "Item not found.")
        if collection == "evidence" and any(r["evidence_id"] == item_id for r in project["finances"]):
            raise HTTPException(409, "Remove financial entries referencing this document first.")
        project[collection] = [item for item in project[collection] if item["id"] != item_id]
        if collection == "evidence":
            project["open_data"] = [d for d in project["open_data"] if d["evidence_id"] != item_id]
        project["revision"] += 1
    return store.mutate(project_id, remove)


@app.post("/api/projects/{project_id}/investigate")
async def run_investigation(project_id: str, data: InvestigationInput):
    project = project_or_404(project_id)
    if not project["evidence"]:
        raise HTTPException(422, "Add evidence before starting an investigation.")
    checks = analyze(project)
    ai_result = None
    if data.use_ai:
        chosen = ai.provider(data.provider)
        if not chosen:
            raise HTTPException(422, "AI is not configured on this server.")
        if not store.reserve_ai_run(daily_ai_limit()):
            raise HTTPException(429, f"The daily limit of {daily_ai_limit()} AI investigations has been reached. "
                                     "Financial checks are still available.")
        try:
            extra = {"provider_id": chosen["id"]} if chosen["id"] != "default" else {}
            if data.depth == "deep":
                extra["depth"] = "deep"
            ai_result = await asyncio.wait_for(ai.investigate(project, checks, **extra), timeout=900 if data.depth == "deep" else 200)
        except Exception as error:
            # Provider exceptions can contain credentials or uploaded text. Return only the failure class.
            raise HTTPException(502, f"{chosen['label']}: {ai.failure_reason(error)} No report was saved.")
        checks["findings"].extend(ai_result["findings"])
        checks["missing_records"] = list(dict.fromkeys(checks["missing_records"] + ai_result["missing_records"]))
    for finding in checks["findings"]:
        finding["key"] = finding_key(finding)
    from . import ml
    checks["calibration"] = ml.calibration(checks["findings"])
    report = {
        **checks, "id": store.identifier("report"), "created_at": store.now(),
        "revision": project["revision"], "demo": project["demo"],
        "mode": "ai" if data.use_ai else "checks",
        "depth": ai_result.get("depth", "quick") if ai_result else None,
        "model": ai_result["model"] if ai_result else None,
        "activity": ai_result["activity"] if ai_result else [],
        "passes": ai_result.get("passes", []) if ai_result else [],
        "answers": ai_result.get("answers", []) if ai_result else [],
        "rejected_findings": ai_result["rejected_findings"] if ai_result else 0,
        "source_catalog": project["evidence"],
    }

    def save(current):
        if current["revision"] != project["revision"]:
            raise HTTPException(409, "Case evidence changed during investigation. Run again on the latest records.")
        current["reports"].append(report)
    return store.mutate(project_id, save)


CONCLUSORY = re.compile(r"\b(corrupt\w*|fraud\w*|brib\w+|kickback\w*|collusi\w+|rigg\w+|criminal\w*|stole\w*|theft|embezzl\w+|launder\w+)\b", re.I)
DISCUSSION_NOTICE = ("Members of this workspace can see what you write about named companies and people. Stick to what the "
                     "documents show and cite them; conclusory language without a citation is posted as opinion. Nothing here "
                     "is published outside the workspace, but it is sent to the AI provider with each investigation.")


def comment_view(comment, members):
    names = {m["id"]: m["name"] for m in members}
    return {**comment, "assignee_name": names.get(comment.get("assignee_id"))} if "assignee_id" in comment else comment


@app.get("/api/projects/{project_id}/discussion")
def discussion(request: Request, project_id: str):
    project = project_or_404(project_id)
    members = store.members(include_inactive=True)
    statuses = store.finding_statuses(project_id)
    shared = store.discussion_id(project) != project_id
    active = [m for m in members if m["active"]]
    if request.state.user["role"] == "guest":  # a guest may assign an owner by name but does not get the team's email addresses
        active = [{"id": m["id"], "name": m["name"], "role": m["role"], "active": 1} for m in active]
    return {"comments": store.discussion(project), "statuses": [comment_view(s, members) for s in statuses.values()],
            "members": active, "notice": DISCUSSION_NOTICE + guest_notice(), "me": request.state.user,
            "shared_streets": [location["road"] for location in project["locations"]] if shared else []}


@app.post("/api/projects/{project_id}/comments", status_code=201)
def add_comment(request: Request, project_id: str, data: CommentInput):
    project = project_or_404(project_id)
    user = request.state.user
    if data.kind == "assessment" and not data.assessment:
        raise HTTPException(422, "An assessment needs its structured fields.")
    if data.kind == "comment" and not data.body.strip():
        raise HTTPException(422, "Write something first.")
    citations = [c.model_dump() for c in data.citations]
    bad = [c for c in citations if not citation_valid(c, project)]
    if bad:
        raise HTTPException(422, "A citation's quotation does not appear on that page of that document.")
    titles = {document["id"]: document["title"] for document in project["evidence"]}
    citations = [{**c, "title": titles.get(c["evidence_id"], "")} for c in citations]
    if data.parent_id and not store.get_comment(data.parent_id):
        raise HTTPException(404, "The comment you are replying to no longer exists.")
    text = data.body + " " + (data.assessment.summary if data.assessment else "")
    comment = store.add_comment(store.discussion_id(project), {
        "case_id": project_id, "case_name": project["name"],
        "kind": data.kind, "anchor_type": data.anchor_type, "anchor_id": data.anchor_id, "anchor_label": data.anchor_label,
        "parent_id": data.parent_id, "author_id": user["id"], "author_name": user["name"], "author_role": user["role"],
        "body": data.body.strip(), "citations": citations, "assessment": data.assessment.model_dump() if data.assessment else None,
        "opinion": bool(CONCLUSORY.search(text)) and not citations,
    })
    return comment


@app.put("/api/projects/{project_id}/comments/{comment_id}")
def edit_comment(request: Request, project_id: str, comment_id: str, data: CommentUpdate):
    project = project_or_404(project_id)
    comment = store.get_comment(comment_id)
    if not comment or comment["project_id"] not in (project_id, store.discussion_id(project)):
        raise HTTPException(404, "Comment not found.")
    user = request.state.user
    if comment["author_id"] != user["id"] and user["role"] != "admin":
        raise HTTPException(403, "Only the author or an admin can edit this.")
    if data.body is not None:
        comment["body"] = data.body.strip()
    if data.assessment is not None:
        comment["assessment"] = data.assessment.model_dump()
    text = comment["body"] + " " + ((comment.get("assessment") or {}).get("summary") or "")
    comment["opinion"] = bool(CONCLUSORY.search(text)) and not comment.get("citations")
    comment["edited_at"] = store.now()
    return store.save_comment(comment)


@app.delete("/api/projects/{project_id}/comments/{comment_id}")
def remove_comment(request: Request, project_id: str, comment_id: str):
    project = project_or_404(project_id)
    comment = store.get_comment(comment_id)
    if not comment or comment["project_id"] not in (project_id, store.discussion_id(project)):
        raise HTTPException(404, "Comment not found.")
    user = request.state.user
    if comment["author_id"] != user["id"] and user["role"] != "admin":
        raise HTTPException(403, "Only the author or an admin can delete this.")
    store.delete_comment(comment_id)
    return {"deleted": comment_id}


@app.put("/api/projects/{project_id}/findings/{key}/status")
def set_status(request: Request, project_id: str, key: str, data: FindingStatusInput):
    project_or_404(project_id)
    user = request.state.user
    if data.assignee_id and data.assignee_id not in {m["id"] for m in store.members()} | {"admin", "local"}:
        raise HTTPException(404, "Assignee is not a member.")
    return store.set_finding_status(project_id, key, {
        "status": data.status, "assignee_id": data.assignee_id, "note": data.note.strip(), "title": data.title,
        "updated_by": user["name"], "updated_by_id": user["id"],
    })


@app.get("/api/projects/{project_id}/export")
def export(project_id: str):
    project = project_or_404(project_id)
    project = {**project, "discussion": store.discussion(project), "finding_statuses": list(store.finding_statuses(project_id).values())}
    return Response(
        json.dumps(project, ensure_ascii=False, indent=2), media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="roadwatch-{project_id}.json"'},
    )
