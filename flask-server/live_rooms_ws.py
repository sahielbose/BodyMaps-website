"""Async WebSocket service for BodyMaps Live Rooms.

Run separately from Gunicorn so long-lived room connections never consume Flask
request threads.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import os
import re
import signal
import time
import uuid
import weakref
from collections import OrderedDict, defaultdict, deque
from dataclasses import dataclass, field
from typing import Any

from dotenv import load_dotenv
from websockets.asyncio.server import ServerConnection, serve
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Response

from constants import Constants
from services.live_room_store import (
    DURABLE_TYPES,
    LiveRoomError,
    LiveRoomStore,
    RoomExpired,
    RoomNotFound,
    isoformat,
    parse_time,
    utcnow,
)
from services.request_limits import PersistentRateLimiter, trusted_client_ip

try:
    import fcntl
except ImportError:  # pragma: no cover - production is Linux
    fcntl = None


load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
logging.basicConfig(level=os.getenv("LIVE_ROOMS_LOG_LEVEL", "INFO"))
logger = logging.getLogger("bodymaps.live_rooms")

HOST = os.getenv("LIVE_ROOMS_WS_HOST", "127.0.0.1")
PORT = int(os.getenv("LIVE_ROOMS_WS_PORT", "8001"))
MAX_PARTICIPANTS = 8
MAX_FRAME_BYTES = 512 * 1024
MAX_HELLO_BYTES = 4 * 1024
MAX_TRANSIENT_BYTES = 16 * 1024
MAX_IDENTITY_BYTES_PER_10_SECONDS = 2 * 1024 * 1024
MAX_IP_BYTES_PER_10_SECONDS = 8 * 1024 * 1024
MAX_ROOM_BYTES_PER_10_SECONDS = 16 * 1024 * 1024
SEND_TIMEOUT_SECONDS = 5
MAX_MASK_CHUNKS = 256
MAX_MASK_CHUNK_RANGES = 50_000
MAX_PENDING_MASK_OPERATIONS = 4
MAX_PENDING_MASK_RANGES_PER_PEER = 100_000
MASK_CHUNK_TTL_SECONDS = 60
HOST_PROMOTION_GRACE_SECONDS = 15
ROOM_PATH = re.compile(r"^/ws/live-rooms/([0-9a-f-]{36})$")
DEFAULT_ALLOWED_ORIGINS = "https://bodymaps.wse.jhu.edu"


def _finite_vector(value: Any) -> list[float]:
    if (
        not isinstance(value, list)
        or len(value) != 3
        or any(isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item) for item in value)
    ):
        raise LiveRoomError("Transient vector must contain three finite numbers")
    return [float(item) for item in value]


def _short_nullable_string(value: Any, field_name: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 64:
        raise LiveRoomError(f"{field_name} must be null or a short string")
    return value


def _sanitize_transient_payload(event_type: str, raw: dict[str, Any]) -> dict[str, Any]:
    if event_type == "presence.update":
        allowed = {"cursor", "crosshair", "active_tool", "target_organ", "plane", "following"}
        if set(raw) - allowed:
            raise LiveRoomError("Presence payload contains unsupported fields")
        clean: dict[str, Any] = {}
        if "cursor" in raw:
            cursor = raw["cursor"]
            if cursor is None:
                clean["cursor"] = None
            elif isinstance(cursor, dict) and set(cursor) == {"pane", "x", "y"}:
                pane = _short_nullable_string(cursor["pane"], "cursor.pane")
                x, y = cursor["x"], cursor["y"]
                if (
                    not pane
                    or isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x)
                    or isinstance(y, bool) or not isinstance(y, (int, float)) or not math.isfinite(y)
                    or not (0 <= x <= 1 and 0 <= y <= 1)
                ):
                    raise LiveRoomError("cursor must contain a pane and normalized finite coordinates")
                clean["cursor"] = {"pane": pane, "x": float(x), "y": float(y)}
            else:
                raise LiveRoomError("cursor must be null or a cursor object")
        if "crosshair" in raw:
            clean["crosshair"] = None if raw["crosshair"] is None else _finite_vector(raw["crosshair"])
        for key in ("active_tool", "target_organ", "plane", "following"):
            if key in raw:
                clean[key] = _short_nullable_string(raw[key], key)
        return clean

    if set(raw) != {"view"} or not isinstance(raw["view"], dict):
        raise LiveRoomError("view.update payload must contain only a view object")
    source = raw["view"]
    allowed_view = {"crosshair", "cameras", "windowWidth", "windowCenter", "opacity", "visibleOrgans"}
    if set(source) - allowed_view:
        raise LiveRoomError("View payload contains unsupported fields")
    view: dict[str, Any] = {}
    if "crosshair" in source:
        view["crosshair"] = None if source["crosshair"] is None else _finite_vector(source["crosshair"])
    if "cameras" in source:
        cameras = source["cameras"]
        if not isinstance(cameras, dict) or set(cameras) - {"axial", "sagittal", "coronal"}:
            raise LiveRoomError("View cameras are invalid")
        clean_cameras: dict[str, Any] = {}
        allowed_camera = {"focalPoint", "position", "viewUp", "viewPlaneNormal", "parallelScale", "flipHorizontal", "flipVertical"}
        for pane, camera in cameras.items():
            if not isinstance(camera, dict) or set(camera) - allowed_camera:
                raise LiveRoomError("View camera contains unsupported fields")
            clean_camera: dict[str, Any] = {}
            for key in ("focalPoint", "position", "viewUp", "viewPlaneNormal"):
                if key in camera:
                    clean_camera[key] = _finite_vector(camera[key])
            if "parallelScale" in camera:
                scale = camera["parallelScale"]
                if isinstance(scale, bool) or not isinstance(scale, (int, float)) or not math.isfinite(scale):
                    raise LiveRoomError("Camera scale must be finite")
                clean_camera["parallelScale"] = float(scale)
            for key in ("flipHorizontal", "flipVertical"):
                if key in camera:
                    if not isinstance(camera[key], bool):
                        raise LiveRoomError("Camera flip fields must be boolean")
                    clean_camera[key] = camera[key]
            clean_cameras[pane] = clean_camera
        view["cameras"] = clean_cameras
    for key in ("windowWidth", "windowCenter", "opacity"):
        if key in source:
            value = source[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise LiveRoomError(f"{key} must be finite")
            view[key] = float(value)
    if "visibleOrgans" in source:
        visible = source["visibleOrgans"]
        if not isinstance(visible, list) or len(visible) > 256 or not all(isinstance(item, bool) for item in visible):
            raise LiveRoomError("visibleOrgans must be a bounded boolean list")
        view["visibleOrgans"] = visible
    return {"view": view}


@dataclass
class Peer:
    websocket: ServerConnection
    room_id: str
    room_key: str
    participant_id: str
    name: str
    color: str
    role: str = "student"
    lease_id: str = ""
    client_ip: str = ""
    generation: int = 0
    ready: bool = False
    host_claim_pending: bool = False
    connected_at: float = field(default_factory=time.monotonic)
    presence: dict[str, Any] = field(default_factory=dict)
    limits: dict[str, deque[float]] = field(default_factory=lambda: defaultdict(deque))
    mask_chunks: dict[str, dict[int, list[dict[str, int]]]] = field(default_factory=dict)
    mask_chunk_meta: dict[str, dict[str, Any]] = field(default_factory=dict)
    byte_events: deque[tuple[float, int]] = field(default_factory=deque)
    pending_messages: deque[dict[str, Any]] = field(default_factory=deque)

    def allow(self, family: str, limit: int, window_seconds: float) -> bool:
        now = time.monotonic()
        attempts = self.limits[family]
        while attempts and now - attempts[0] >= window_seconds:
            attempts.popleft()
        if len(attempts) >= limit:
            return False
        attempts.append(now)
        return True

    def public(self) -> dict[str, Any]:
        return {
            "participant_id": self.participant_id,
            "name": self.name,
            "color": self.color,
            "role": self.role,
            **self.presence,
        }

    def allow_bytes(self, size: int, limit: int, window_seconds: float = 10) -> bool:
        now = time.monotonic()
        while self.byte_events and now - self.byte_events[0][0] >= window_seconds:
            self.byte_events.popleft()
        if sum(item[1] for item in self.byte_events) + size > limit:
            return False
        self.byte_events.append((now, size))
        return True

    def prune_mask_chunks(self) -> None:
        cutoff = time.monotonic() - MASK_CHUNK_TTL_SECONDS
        stale = [
            operation_id
            for operation_id, metadata in self.mask_chunk_meta.items()
            if float(metadata.get("received_at", 0)) < cutoff
        ]
        for operation_id in stale:
            self.mask_chunk_meta.pop(operation_id, None)
            self.mask_chunks.pop(operation_id, None)


class LiveRoomWebSocketService:
    COLORS = ("#22d3ee", "#f59e0b", "#a78bfa", "#34d399", "#fb7185", "#60a5fa", "#f472b6", "#facc15")

    def __init__(self, store: LiveRoomStore) -> None:
        self.store = store
        self.rooms: dict[str, dict[str, Peer]] = defaultdict(dict)
        self.lock = asyncio.Lock()
        self.lifecycle_locks: weakref.WeakValueDictionary[str, asyncio.Lock] = weakref.WeakValueDictionary()
        self.generations: dict[tuple[str, str], int] = {}
        self.deadline_tasks: dict[str, asyncio.Task] = {}
        self.promotion_tasks: dict[str, asyncio.Task] = {}
        self.identity_limits: OrderedDict[
            tuple[str, str], dict[str, deque[float]]
        ] = OrderedDict()
        self.shared_byte_limits: OrderedDict[tuple[str, str], deque[tuple[float, int]]] = OrderedDict()
        self.ready = False
        self.connection_limiter = PersistentRateLimiter(
            self.store.root.parent / "request-rate-limits.sqlite3"
        )

    @staticmethod
    async def send_json(websocket: ServerConnection, message: dict[str, Any]) -> None:
        encoded = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        try:
            await asyncio.wait_for(websocket.send(encoded), timeout=SEND_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(
                    websocket.close(code=4009, reason="Peer is not receiving messages"),
                    timeout=SEND_TIMEOUT_SECONDS,
                )
            raise

    def _lifecycle_lock(self, room_id: str) -> asyncio.Lock:
        return self.lifecycle_locks.setdefault(room_id, asyncio.Lock())

    async def _allow_shared_bytes(self, scope: str, key: str, size: int, limit: int) -> bool:
        now = time.monotonic()
        async with self.lock:
            rate_key = (scope, key)
            events = self.shared_byte_limits.setdefault(rate_key, deque())
            while events and now - events[0][0] >= 10:
                events.popleft()
            if sum(item[1] for item in events) + size > limit:
                return False
            events.append((now, size))
            self.shared_byte_limits.move_to_end(rate_key)
            while len(self.shared_byte_limits) > 8_192:
                self.shared_byte_limits.popitem(last=False)
            return True

    async def error(
        self,
        websocket: ServerConnection,
        error: Exception | str,
        *,
        fatal: bool = False,
        event_id: str | None = None,
    ) -> None:
        if isinstance(error, LiveRoomError):
            code = error.code
            message = str(error)
        else:
            code = "invalid_message"
            message = str(error)
        try:
            payload = {"type": "error", "code": code, "message": message, "fatal": fatal}
            if event_id:
                payload["event_id"] = event_id
            await self.send_json(websocket, payload)
        except (ConnectionClosed, asyncio.TimeoutError):
            return
        if fatal:
            await websocket.close(code=4003, reason=message[:120])

    async def broadcast(self, room_id: str, message: dict[str, Any], *, exclude: str | None = None) -> None:
        async with self.lock:
            peers = []
            for participant_id, peer in self.rooms.get(room_id, {}).items():
                if participant_id == exclude:
                    continue
                if peer.ready:
                    peers.append(peer)
                else:
                    # A peer is subscribed before replay starts. Broadcasts that
                    # race room.ready are drained in order before it becomes ready.
                    peer.pending_messages.append(message)
        if not peers:
            return
        results = await asyncio.gather(
            *(self.send_json(peer.websocket, message) for peer in peers),
            return_exceptions=True,
        )
        for peer, result in zip(peers, results):
            if isinstance(result, (asyncio.TimeoutError, ConnectionClosed, OSError)):
                with contextlib.suppress(Exception):
                    await peer.websocket.close(code=4009, reason="Peer send failed")

    async def _flush_pending_and_mark_ready(self, peer: Peer, through_seq: int) -> bool:
        while True:
            async with self.lock:
                if self.rooms.get(peer.room_id, {}).get(peer.participant_id) is not peer:
                    return False
                pending = [
                    message
                    for message in peer.pending_messages
                    if not (
                        message.get("type") == "event.committed"
                        and int((message.get("event") or {}).get("seq", through_seq + 1)) <= through_seq
                    )
                ]
                peer.pending_messages.clear()
                if not pending:
                    peer.ready = True
                    return True
            for message in pending:
                await self.send_json(peer.websocket, message)

    async def _broadcast_quiz_event(self, room_id: str, event: dict[str, Any]) -> None:
        await self.broadcast(room_id, {"type": "event.committed", "event": event, "duplicate": False})

    async def _connected_students(self, room_id: str) -> list[dict[str, str]]:
        async with self.lock:
            return [
                {"participant_id": peer.participant_id, "name": peer.name}
                for peer in self.rooms.get(room_id, {}).values()
                if peer.role != "host" and peer.ready
            ]

    async def _connected_student_ids(self, room_id: str) -> set[str]:
        return {item["participant_id"] for item in await self._connected_students(room_id)}

    async def _send_quiz_personal(self, room_id: str) -> None:
        async with self.lock:
            peers = [peer for peer in self.rooms.get(room_id, {}).values() if peer.ready]
        for peer in peers:
            try:
                context = await asyncio.to_thread(
                    self.store.quiz_context,
                    room_id,
                    peer.room_key,
                    peer.participant_id,
                )
                if context:
                    await self.send_json(peer.websocket, {"type": "quiz.personal", "quiz": context})
            except (ConnectionClosed, asyncio.TimeoutError, LiveRoomError):
                continue

    def _cancel_deadline(self, room_id: str) -> None:
        task = self.deadline_tasks.pop(room_id, None)
        if task and task is not asyncio.current_task():
            task.cancel()

    def _schedule_deadline(self, room_id: str, quiz: dict[str, Any]) -> None:
        self._cancel_deadline(room_id)
        deadline = quiz.get("deadline_at")
        if quiz.get("phase") != "question_open" or quiz.get("timer_paused") or not deadline:
            return
        delay = max(0.0, (parse_time(str(deadline)) - utcnow()).total_seconds())
        self.deadline_tasks[room_id] = asyncio.create_task(self._deadline_worker(room_id, delay))

    async def _deadline_worker(self, room_id: str, delay: float) -> None:
        try:
            await asyncio.sleep(delay)
            result = await asyncio.to_thread(self.store.close_quiz_if_due, room_id)
            if result:
                quiz, event = result
                await self._broadcast_quiz_event(room_id, event)
                await self.broadcast(room_id, {"type": "quiz.state", "quiz": quiz})
        except asyncio.CancelledError:
            return
        except LiveRoomError as exc:
            logger.warning("Quiz deadline failed room=%s error=%s", room_id, exc)
        finally:
            if self.deadline_tasks.get(room_id) is asyncio.current_task():
                self.deadline_tasks.pop(room_id, None)

    def _schedule_promotion(self, room_id: str, delay: float = HOST_PROMOTION_GRACE_SECONDS) -> None:
        existing = self.promotion_tasks.get(room_id)
        if existing and not existing.done():
            return
        self.promotion_tasks[room_id] = asyncio.create_task(self._promotion_worker(room_id, delay))

    async def _promotion_worker(self, room_id: str, delay: float) -> None:
        try:
            await asyncio.sleep(delay)
            rollback: tuple[dict[str, Any], dict[str, Any] | None] | None = None
            async with self._lifecycle_lock(room_id):
                async with self.lock:
                    peers = [peer for peer in self.rooms.get(room_id, {}).values() if peer.ready]
                    if any(peer.role == "host" for peer in peers):
                        return
                    candidate = min(peers, key=lambda peer: peer.connected_at, default=None)
                if not candidate:
                    return
                if await asyncio.to_thread(
                    self.store.quiz_host_claim_pending, room_id, candidate.room_key
                ):
                    return
                quiz, event, previous_host = await asyncio.to_thread(
                    self.store.promote_quiz_host,
                    room_id,
                    candidate.participant_id,
                    candidate.lease_id,
                )
                candidate.role = "host"
                try:
                    await self.send_json(candidate.websocket, {
                        "type": "quiz.host.promoted",
                        "quiz": quiz,
                    })
                except (ConnectionClosed, asyncio.TimeoutError, OSError):
                    candidate.role = "student"
                    rollback = await asyncio.to_thread(
                        self.store.rollback_quiz_host_promotion,
                        room_id,
                        candidate.participant_id,
                        candidate.lease_id,
                        previous_host,
                    )
            if rollback:
                rollback_quiz, rollback_event = rollback
                if rollback_event:
                    await self._broadcast_quiz_event(room_id, rollback_event)
                await self.broadcast(room_id, {"type": "quiz.state", "quiz": rollback_quiz})
                return
            async with self.lock:
                participants = [peer.public() for peer in self.rooms.get(room_id, {}).values()]
            await self.broadcast(room_id, {
                "type": "presence.changed",
                "change": "host_promoted",
                "participant": candidate.public(),
                "participants": participants,
            })
            if event:
                await self._broadcast_quiz_event(room_id, event)
            await self.broadcast(room_id, {"type": "quiz.state", "quiz": quiz})
            self._schedule_deadline(room_id, quiz)
        except asyncio.CancelledError:
            return
        except LiveRoomError as exc:
            logger.warning("Quiz host promotion failed room=%s error=%s", room_id, exc)
        finally:
            if self.promotion_tasks.get(room_id) is asyncio.current_task():
                self.promotion_tasks.pop(room_id, None)

    async def join(
        self,
        websocket: ServerConnection,
        room_id: str,
        hello: dict[str, Any],
        client_ip: str = "unknown",
    ) -> Peer:
        allowed_hello = {
            "type", "protocol", "room_key", "participant_id", "resume_credential",
            "quiz_host_claim", "quiz_host_secret", "name", "last_seq",
        }
        if set(hello) - allowed_hello:
            raise LiveRoomError("hello contains unsupported fields")
        if hello.get("type") != "hello" or hello.get("protocol") != 1:
            raise LiveRoomError("First frame must be a protocol 1 hello")
        room_key = hello.get("room_key", "")
        requested_participant_id = hello.get("participant_id", "")
        resume_credential = hello.get("resume_credential", "")
        new_host_claim = hello.get("quiz_host_claim", "")
        legacy_host_claim = hello.get("quiz_host_secret", "")
        if not all(
            isinstance(value, str)
            for value in (
                room_key,
                requested_participant_id,
                resume_credential,
                new_host_claim,
                legacy_host_claim,
            )
        ):
            raise LiveRoomError("hello credentials must be strings")
        if new_host_claim and legacy_host_claim and new_host_claim != legacy_host_claim:
            raise LiveRoomError("quiz host credential aliases do not match")
        legacy_host_mode = bool(legacy_host_claim and not new_host_claim)
        host_claim = new_host_claim or legacy_host_claim
        if any(len(value) > 256 for value in (room_key, requested_participant_id, resume_credential, host_claim)):
            raise LiveRoomError("hello credential is too long")
        last_seq = hello.get("last_seq", 0)
        if isinstance(last_seq, bool) or not isinstance(last_seq, int) or last_seq < 0:
            error = LiveRoomError("last_seq must be a non-negative integer")
            error.code = "invalid_last_seq"
            raise error
        raw_name = hello.get("name", "Guest")
        if not isinstance(raw_name, str):
            raise LiveRoomError("Display name must be a string")
        name = "".join(ch for ch in raw_name if ord(ch) >= 32).strip()[:32]
        if not name:
            raise LiveRoomError("Display name is required")

        existing: Peer | None = None
        host_event: dict[str, Any] | None = None
        quiz_state: dict[str, Any] | None = None
        async with self._lifecycle_lock(room_id):
            metadata = await asyncio.to_thread(self.store.verify_key, room_id, room_key)
            if last_seq > int(metadata.get("latest_seq", 0)):
                error = LiveRoomError("last_seq is ahead of the room sequence")
                error.code = "invalid_last_seq"
                raise error
            host_identity = None
            if metadata.get("mode") == "quiz":
                host_identity = await asyncio.to_thread(
                    self.store.quiz_host_identity, room_id, room_key
                )
            async with self.lock:
                replacement_id = requested_participant_id or (
                    str(host_identity) if host_claim and host_identity else ""
                )
                existing = self.rooms.get(room_id, {}).get(replacement_id)
                active_count = len(self.rooms.get(room_id, {})) - (1 if existing else 0)
                active_host = any(
                    peer.role == "host" and peer is not existing
                    for peer in self.rooms.get(room_id, {}).values()
                )
            # The per-room lifecycle lock is the slot reservation. No identity or
            # host state is mutated until capacity is known to be available.
            host_attempt = bool(host_claim) or (
                bool(host_identity) and requested_participant_id == host_identity
            )
            reserve_host_slot = (
                metadata.get("mode") == "quiz"
                and not host_attempt
                and not active_host
                and await asyncio.to_thread(
                    self.store.quiz_host_claim_pending, room_id, room_key
                )
            )
            participant_limit = MAX_PARTICIPANTS - int(reserve_host_slot)
            if active_count >= participant_limit:
                error = LiveRoomError("Room already has 8 participants")
                error.code = "participant_limit"
                error.status_code = 409
                raise error
            participant_id, issued_resume_credential, is_host = await asyncio.to_thread(
                self.store.resolve_participant_identity,
                room_id,
                room_key,
                requested_participant_id,
                resume_credential,
                host_claim,
            )
            lease_id = str(uuid.uuid4())
            role = "host" if is_host else "reviewer" if metadata.get("mode", "review") == "review" else "student"
            if is_host:
                quiz_state, host_event = await asyncio.to_thread(
                    self.store.connect_quiz_host,
                    room_id,
                    room_key,
                    participant_id,
                    lease_id,
                )
                metadata = await asyncio.to_thread(self.store.verify_key, room_id, room_key)
                promotion = self.promotion_tasks.pop(room_id, None)
                if promotion:
                    promotion.cancel()
            async with self.lock:
                existing = self.rooms[room_id].get(participant_id)
                used_colors = {
                    item.color for item in self.rooms[room_id].values()
                    if item.participant_id != participant_id
                }
                color = next(
                    (value for value in self.COLORS if value not in used_colors),
                    self.COLORS[active_count % len(self.COLORS)],
                )
                limit_key = (room_id, participant_id)
                shared_limits = self.identity_limits.get(limit_key)
                if shared_limits is None:
                    shared_limits = defaultdict(deque)
                    self.identity_limits[limit_key] = shared_limits
                    while len(self.identity_limits) > 4_096:
                        self.identity_limits.popitem(last=False)
                else:
                    self.identity_limits.move_to_end(limit_key)
                generation = self.generations.get(limit_key, 0) + 1
                self.generations[limit_key] = generation
                peer = Peer(
                    websocket,
                    room_id,
                    room_key,
                    participant_id,
                    name,
                    color,
                    role=role,
                    lease_id=lease_id,
                    client_ip=client_ip,
                    generation=generation,
                    host_claim_pending=bool(host_claim),
                    connected_at=existing.connected_at if existing else time.monotonic(),
                    limits=shared_limits,
                )
                self.rooms[room_id][participant_id] = peer
                participants = [item.public() for item in self.rooms[room_id].values()]

        # Closing performs a WebSocket handshake and may wait on the old client.
        # Never hold the global room lock during network I/O: otherwise one stale
        # reconnect can delay joins, leaves, and broadcasts in every room.
        if existing:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(
                    existing.websocket.close(code=4000, reason="Reconnected from another tab"),
                    timeout=SEND_TIMEOUT_SECONDS,
                )

        try:
            events, resync_required = await asyncio.to_thread(
                self.store.replay_after, room_id, room_key, last_seq
            )
            ready: dict[str, Any] = {
                "type": "room.ready",
                "room": metadata,
                "latest_seq": metadata["latest_seq"],
                "events": events,
                "participants": participants,
                "self": peer.public(),
                "resync_required": resync_required,
                "at": isoformat(utcnow()),
            }
            if issued_resume_credential:
                ready["resume_credential"] = issued_resume_credential
            if legacy_host_claim:
                # Protocol 1 compatibility alias for rooms created by the prior
                # release. New clients use quiz_host_claim and host.claim_ack.
                ready["quiz_host_secret"] = legacy_host_claim
            if last_seq == 0 or resync_required:
                ready["snapshot"] = await asyncio.to_thread(self.store.get_snapshot, room_id, room_key)
            if metadata.get("mode") == "quiz":
                context = await asyncio.to_thread(self.store.quiz_context, room_id, room_key, participant_id)
                ready["quiz"] = context
                if quiz_state is None and context:
                    quiz_state = context["state"]
            ready_through_seq = max(
                int(metadata.get("latest_seq", 0)),
                *(int(event.get("seq", 0)) for event in events),
                int((ready.get("snapshot") or {}).get("latest_seq", 0)),
            )
            ready["latest_seq"] = ready_through_seq
            ready["room"] = {**metadata, "latest_seq": ready_through_seq}
            await self.send_json(websocket, ready)
            if legacy_host_mode and role == "host":
                await asyncio.to_thread(
                    self.store.acknowledge_quiz_host_claim,
                    room_id,
                    room_key,
                    participant_id,
                    lease_id,
                )
                peer.host_claim_pending = False
            if not await self._flush_pending_and_mark_ready(peer, ready_through_seq):
                return peer
        except Exception:
            await self.leave(peer)
            raise
        await self.broadcast(
            room_id,
            {"type": "presence.changed", "change": "joined", "participant": peer.public(), "participants": participants},
            exclude=participant_id,
        )
        if host_event:
            await self.broadcast(
                room_id,
                {"type": "event.committed", "event": host_event, "duplicate": False},
                exclude=participant_id,
            )
        if role == "host" and quiz_state:
            await self.broadcast(room_id, {"type": "quiz.state", "quiz": quiz_state})
        if quiz_state:
            self._schedule_deadline(room_id, quiz_state)
            # A participant may arrive before the creator opens the room. Host
            # promotion is only recovery for a host that previously claimed
            # the room, not a way to seize an unclaimed creator credential.
            if (
                not quiz_state.get("host_connected")
                and role != "host"
                and await asyncio.to_thread(self.store.quiz_host_assigned, room_id, room_key)
                and not await asyncio.to_thread(
                    self.store.quiz_host_claim_pending, room_id, room_key
                )
            ):
                self._schedule_promotion(room_id, 0)
        logger.info("participant joined room=%s participant=%s count=%d", room_id, participant_id, len(participants))
        return peer

    async def leave(self, peer: Peer) -> None:
        host_result = None
        closed = None
        async with self._lifecycle_lock(peer.room_id):
            async with self.lock:
                current = self.rooms.get(peer.room_id, {}).get(peer.participant_id)
                if current is not peer or current.generation != peer.generation:
                    return
                del self.rooms[peer.room_id][peer.participant_id]
                if not self.rooms[peer.room_id]:
                    del self.rooms[peer.room_id]
                    stale_generation_keys = [
                        key for key in self.generations if key[0] == peer.room_id
                    ]
                    for key in stale_generation_keys:
                        self.generations.pop(key, None)
                    participants: list[dict[str, Any]] = []
                else:
                    participants = [item.public() for item in self.rooms[peer.room_id].values()]
                connected_students = {
                    item.participant_id
                    for item in self.rooms.get(peer.room_id, {}).values()
                    if item.role != "host"
                }
            if peer.role == "host":
                host_result = await asyncio.to_thread(
                    self.store.disconnect_quiz_host,
                    peer.room_id,
                    peer.participant_id,
                    peer.lease_id,
                )
            try:
                closed = await asyncio.to_thread(
                    self.store.close_quiz_if_all_answered,
                    peer.room_id,
                    connected_students,
                )
            except (RoomNotFound, RoomExpired):
                closed = None
        await self.broadcast(
            peer.room_id,
            {
                "type": "presence.changed",
                "change": "left",
                "participant_id": peer.participant_id,
                "participants": participants,
            },
        )
        if host_result:
            quiz, event = host_result
            self._cancel_deadline(peer.room_id)
            if event:
                await self._broadcast_quiz_event(peer.room_id, event)
            await self.broadcast(peer.room_id, {"type": "quiz.state", "quiz": quiz})
            if not await asyncio.to_thread(
                self.store.quiz_host_claim_pending, peer.room_id, peer.room_key
            ):
                self._schedule_promotion(peer.room_id)
        if closed:
            quiz, event = closed
            self._cancel_deadline(peer.room_id)
            await self._broadcast_quiz_event(peer.room_id, event)
            await self.broadcast(peer.room_id, {"type": "quiz.state", "quiz": quiz})

    async def commit(self, peer: Peer, message: dict[str, Any]) -> None:
        event_type = str(message.get("type", ""))
        event_id = str(message.get("event_id", ""))
        payload = message.get("payload")
        if not isinstance(payload, dict):
            raise LiveRoomError("payload must be an object")

        if event_type == "mask.patch" and int(payload.get("chunk_count", 1)) > 1:
            if not peer.allow("mask_chunk", 300, 60):
                raise LiveRoomError("Mask chunk rate limit exceeded")
            peer.prune_mask_chunks()
            operation_id = str(payload.get("operation_id", ""))
            chunk_count = int(payload.get("chunk_count", 0))
            chunk_index = int(payload.get("chunk_index", -1))
            if (
                not operation_id
                or event_id != operation_id
                or not (2 <= chunk_count <= MAX_MASK_CHUNKS)
                or not (0 <= chunk_index < chunk_count)
            ):
                raise LiveRoomError("Invalid mask patch chunk metadata")
            ranges = payload.get("ranges")
            if not isinstance(ranges, list):
                raise LiveRoomError("Mask patch chunk ranges are required")
            expected_meta = {
                key: payload.get(key)
                for key in ("geometry_hash", "resolution", "segment_label", "operation_id", "chunk_count")
            }
            existing_meta = peer.mask_chunk_meta.get(operation_id)
            if existing_meta and any(existing_meta.get(key) != value for key, value in expected_meta.items()):
                peer.mask_chunk_meta.pop(operation_id, None)
                peer.mask_chunks.pop(operation_id, None)
                raise LiveRoomError("Mask patch chunks do not share the same metadata")
            chunks = peer.mask_chunks.setdefault(operation_id, {})
            if operation_id not in peer.mask_chunk_meta and len(peer.mask_chunk_meta) >= MAX_PENDING_MASK_OPERATIONS:
                peer.mask_chunks.pop(operation_id, None)
                raise LiveRoomError("Too many partial mask operations are pending")
            if chunk_index in chunks and chunks[chunk_index] != ranges:
                peer.mask_chunk_meta.pop(operation_id, None)
                peer.mask_chunks.pop(operation_id, None)
                raise LiveRoomError("Mask patch chunk was replaced with different data")
            chunks[chunk_index] = ranges
            peer.mask_chunk_meta.setdefault(operation_id, {**expected_meta, "received_at": time.monotonic()})
            operation_ranges = sum(len(chunk) for chunk in chunks.values())
            peer_ranges = sum(
                len(chunk)
                for operation_chunks in peer.mask_chunks.values()
                for chunk in operation_chunks.values()
            )
            if operation_ranges > MAX_MASK_CHUNK_RANGES or peer_ranges > MAX_PENDING_MASK_RANGES_PER_PEER:
                peer.mask_chunk_meta.pop(operation_id, None)
                peer.mask_chunks.pop(operation_id, None)
                raise LiveRoomError("Mask patch contains too many ranges")
            if len(peer.mask_chunks[operation_id]) < chunk_count:
                return
            payload = peer.mask_chunk_meta.pop(operation_id)
            chunks = peer.mask_chunks.pop(operation_id)
            payload["ranges"] = [item for index in range(chunk_count) for item in chunks[index]]
            payload.pop("chunk_count", None)
            payload.pop("received_at", None)
            event_id = operation_id

        family = "chat" if event_type == "chat.add" else "durable"
        if not peer.allow(family, 12 if family == "chat" else 180, 60):
            raise LiveRoomError("Event rate limit exceeded")

        event, duplicate = await asyncio.to_thread(
            self.store.commit_event,
            peer.room_id,
            peer.room_key,
            event_id=event_id,
            event_type=event_type,
            participant_id=peer.participant_id,
            name=peer.name,
            payload=payload,
        )
        await self.broadcast(
            peer.room_id,
            {"type": "event.committed", "event": event, "duplicate": duplicate},
        )

    async def handle_quiz(self, peer: Peer, message: dict[str, Any]) -> None:
        event_type = str(message.get("type", ""))
        if not peer.allow("quiz", 120, 60):
            await self.error(peer.websocket, "Quiz command rate limit exceeded")
            return
        event: dict[str, Any] | None = None
        if event_type == "quiz.start":
            roster = await self._connected_students(peer.room_id)
            quiz, event = await asyncio.to_thread(
                self.store.start_quiz,
                peer.room_id,
                peer.room_key,
                peer.participant_id,
                peer.lease_id,
                roster,
            )
        elif event_type == "quiz.answer":
            connected = await self._connected_student_ids(peer.room_id)
            quiz, submission, event = await asyncio.to_thread(
                self.store.answer_quiz,
                peer.room_id,
                peer.room_key,
                peer.participant_id,
                peer.name,
                str(message.get("choice_id", "")),
                connected,
            )
            await self.send_json(peer.websocket, {
                "type": "quiz.answer.accepted",
                "question_id": (quiz.get("current_question") or {}).get("id"),
                "submission": submission,
            })
        elif event_type == "quiz.close":
            quiz, event = await asyncio.to_thread(
                self.store.close_quiz_question,
                peer.room_id,
                peer.room_key,
                peer.participant_id,
                peer.lease_id,
            )
        elif event_type == "quiz.reveal":
            quiz, event = await asyncio.to_thread(
                self.store.reveal_quiz_question,
                peer.room_id,
                peer.room_key,
                peer.participant_id,
                peer.lease_id,
            )
        elif event_type == "quiz.advance":
            roster = await self._connected_students(peer.room_id)
            quiz, event = await asyncio.to_thread(
                self.store.advance_quiz,
                peer.room_id,
                peer.room_key,
                peer.participant_id,
                peer.lease_id,
                roster,
            )
        else:
            raise LiveRoomError("Unknown quiz command")

        if event:
            await self._broadcast_quiz_event(peer.room_id, event)
        await self.broadcast(peer.room_id, {"type": "quiz.state", "quiz": quiz})
        await self._send_quiz_personal(peer.room_id)
        self._schedule_deadline(peer.room_id, quiz)

    async def handle_message(self, peer: Peer, message: dict[str, Any]) -> None:
        if not isinstance(message.get("type"), str):
            raise LiveRoomError("Message type must be a string")
        event_type = message["type"]
        durable_fields = {"type", "event_id", "payload"}
        transient_fields = {
            "presence.update": {"type", "payload"},
            "view.update": {"type", "payload"},
            "quiz.answer": {"type", "choice_id"},
            "quiz.start": {"type"},
            "quiz.close": {"type"},
            "quiz.reveal": {"type"},
            "quiz.advance": {"type"},
            "host.claim_ack": {"type"},
            "undo.request": {"type"},
            "ping": {"type"},
        }
        allowed_fields = durable_fields if event_type in DURABLE_TYPES else transient_fields.get(event_type)
        if allowed_fields is not None and set(message) - allowed_fields:
            raise LiveRoomError(f"{event_type} contains unsupported fields")
        if event_type not in DURABLE_TYPES:
            encoded_size = len(json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            if encoded_size > MAX_TRANSIENT_BYTES:
                raise LiveRoomError("Transient message is too large")
        if event_type in {"quiz.start", "quiz.answer", "quiz.close", "quiz.reveal", "quiz.advance"}:
            if event_type == "quiz.answer" and (
                not isinstance(message.get("choice_id"), str) or len(message["choice_id"]) > 128
            ):
                raise LiveRoomError("choice_id must be a short string")
            await self.handle_quiz(peer, message)
            return
        if event_type == "host.claim_ack":
            if peer.role != "host":
                error = LiveRoomError("Only the active quiz host can acknowledge a claim")
                error.code = "invalid_host_lease"
                raise error
            await asyncio.to_thread(
                self.store.acknowledge_quiz_host_claim,
                peer.room_id,
                peer.room_key,
                peer.participant_id,
                peer.lease_id,
            )
            peer.host_claim_pending = False
            await self.send_json(peer.websocket, {"type": "host.claim_acknowledged"})
            return
        if event_type in DURABLE_TYPES:
            await self.commit(peer, message)
            return
        if event_type in {"presence.update", "view.update"}:
            family = "presence" if event_type == "presence.update" else "view"
            if not peer.allow(family, 100, 5):
                return
            if not isinstance(message.get("payload"), dict):
                raise LiveRoomError("Presence payload must be an object")
            raw = message["payload"]
            allowed = _sanitize_transient_payload(event_type, raw)
            peer.presence.update(allowed)
            await self.broadcast(
                peer.room_id,
                {"type": "presence.changed", "change": "updated", "participant": peer.public()},
                exclude=peer.participant_id,
            )
            return
        if event_type == "undo.request":
            if not peer.allow("undo", 20, 60):
                await self.error(peer.websocket, "Undo rate limit exceeded")
                return
            result = await asyncio.to_thread(
                self.store.undo_latest, peer.room_id, peer.room_key, peer.participant_id, peer.name
            )
            await self.send_json(peer.websocket, {"type": "undo.result", **result})
            if result.get("event"):
                await self.broadcast(peer.room_id, {"type": "event.committed", "event": result["event"]})
            return
        if event_type == "ping":
            await self.send_json(peer.websocket, {"type": "pong", "at": isoformat(utcnow())})
            return
        raise LiveRoomError("Unknown message type")

    async def handler(self, websocket: ServerConnection) -> None:
        path = websocket.request.path if websocket.request else ""
        match = ROOM_PATH.match(path.split("?", 1)[0])
        if not match:
            await websocket.close(code=4004, reason="Room path not found")
            return
        room_id = match.group(1)
        peer: Peer | None = None
        try:
            remote_addr = websocket.remote_address[0] if websocket.remote_address else None
            headers = websocket.request.headers if websocket.request else {}
            client_ip = trusted_client_ip(remote_addr, headers)
            allowed = await asyncio.to_thread(
                self.connection_limiter.allow,
                "live_room_ws_connect",
                client_ip,
                120,
                60,
            )
            if not allowed:
                await websocket.close(code=4008, reason="Connection rate limit exceeded")
                return
            try:
                raw_hello = await asyncio.wait_for(websocket.recv(), timeout=10)
            except asyncio.TimeoutError:
                await self.error(websocket, "Hello frame timed out", fatal=True)
                return
            if not isinstance(raw_hello, str):
                raise LiveRoomError("Binary frames are not supported")
            hello_bytes = len(raw_hello.encode("utf-8"))
            if hello_bytes > MAX_HELLO_BYTES or not await self._allow_shared_bytes(
                "ip", client_ip, hello_bytes, MAX_IP_BYTES_PER_10_SECONDS
            ):
                await websocket.close(code=4008, reason="Hello rate or size limit exceeded")
                return
            hello = json.loads(raw_hello)
            if not isinstance(hello, dict):
                raise LiveRoomError("hello must be an object")
            peer = await self.join(websocket, room_id, hello, client_ip)
            async for raw in websocket:
                message: dict[str, Any] | None = None
                if not isinstance(raw, str):
                    await self.error(websocket, "Binary frames are not supported")
                    continue
                try:
                    raw_bytes = len(raw.encode("utf-8"))
                    if (
                        not peer.allow_bytes(raw_bytes, MAX_IDENTITY_BYTES_PER_10_SECONDS)
                        or not await self._allow_shared_bytes(
                            "participant",
                            f"{room_id}:{peer.participant_id}",
                            raw_bytes,
                            MAX_IDENTITY_BYTES_PER_10_SECONDS,
                        )
                        or not await self._allow_shared_bytes("ip", peer.client_ip, raw_bytes, MAX_IP_BYTES_PER_10_SECONDS)
                        or not await self._allow_shared_bytes("room", room_id, raw_bytes, MAX_ROOM_BYTES_PER_10_SECONDS)
                    ):
                        await websocket.close(code=4008, reason="Byte rate limit exceeded")
                        return
                    message = json.loads(raw)
                    if not isinstance(message, dict):
                        raise LiveRoomError("Message must be an object")
                    await self.handle_message(peer, message)
                except (json.JSONDecodeError, LiveRoomError, ValueError, TypeError) as exc:
                    event_id = str(message.get("event_id", "")) if message else ""
                    await self.error(websocket, exc, event_id=event_id or None)
        except asyncio.TimeoutError:
            pass
        except (json.JSONDecodeError, LiveRoomError, ValueError, TypeError) as exc:
            await self.error(websocket, exc, fatal=True)
        except ConnectionClosed:
            pass
        except Exception:
            logger.exception("Unhandled WebSocket error room=%s", room_id)
            await self.error(websocket, "Live room service error", fatal=True)
        finally:
            if peer:
                await self.leave(peer)

    async def expire_rooms_once(self) -> None:
        async with self.lock:
            active_room_ids = list(self.rooms)
        for room_id in active_room_ids:
            try:
                async with self.lock:
                    peer = next(iter(self.rooms.get(room_id, {}).values()), None)
                if peer:
                    await asyncio.to_thread(self.store.verify_key, room_id, peer.room_key)
            except (RoomExpired, RoomNotFound):
                await self.broadcast(room_id, {"type": "room.expired"})
                async with self.lock:
                    peers = list(self.rooms.get(room_id, {}).values())
                await asyncio.gather(
                    *(item.websocket.close(code=4001, reason="Room expired") for item in peers),
                    return_exceptions=True,
                )
            except LiveRoomError as exc:
                logger.warning("Room expiry check failed room=%s error=%s", room_id, exc)

    async def expire_rooms(self) -> None:
        while True:
            await asyncio.sleep(30)
            await self.expire_rooms_once()

    async def shutdown(self) -> None:
        self.ready = False
        tasks = list(self.deadline_tasks.values()) + list(self.promotion_tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        async with self.lock:
            peers = [peer for room in self.rooms.values() for peer in room.values()]
        await asyncio.gather(
            *(peer.websocket.close(code=1001, reason="Service shutting down") for peer in peers),
            return_exceptions=True,
        )


_active_service: LiveRoomWebSocketService | None = None


def process_request(_connection: ServerConnection, request) -> Response | None:
    if request.path == "/health":
        ready = bool(_active_service and _active_service.ready)
        status = "ok" if ready else "starting"
        body = json.dumps({"status": status, "service": "live-rooms-websocket"}).encode("utf-8")
        headers = Headers()
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(body))
        return Response(200 if ready else 503, "OK" if ready else "Service Unavailable", headers, body)
    return None


def _allowed_origins() -> list[str]:
    configured = os.getenv("LIVE_ROOMS_ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS)
    origins = [item.strip() for item in configured.split(",") if item.strip()]
    if not origins or any("*" in origin for origin in origins):
        raise RuntimeError("LIVE_ROOMS_ALLOWED_ORIGINS must be an exact, non-wildcard allowlist")
    for origin in origins:
        if not re.fullmatch(r"https?://[^/\s]+", origin):
            raise RuntimeError(f"Invalid Live Rooms origin: {origin}")
    return origins


@contextlib.contextmanager
def _singleton_lock(store: LiveRoomStore):
    path = store.root / ".websocket-service.lock"
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    os.fchmod(descriptor, 0o600)
    try:
        if fcntl is not None:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RuntimeError("Another Live Rooms websocket service is already running") from exc
        yield
    finally:
        if fcntl is not None:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


async def main() -> None:
    global _active_service
    store = LiveRoomStore(Constants.SESSIONS_DIR_NAME, Constants.PANTS_PATH)
    service = LiveRoomWebSocketService(store)
    _active_service = service
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(signum, stop.set)
    with _singleton_lock(store):
        reconciled = await asyncio.to_thread(store.reconcile_stale_host_leases)
        if reconciled:
            logger.warning("Reconciled %d stale quiz host lease(s)", reconciled)
        expiry_task = asyncio.create_task(service.expire_rooms(), name="live-room-expiry")
        try:
            async with serve(
                service.handler,
                HOST,
                PORT,
                max_size=MAX_FRAME_BYTES,
                max_queue=16,
                ping_interval=20,
                ping_timeout=20,
                process_request=process_request,
                origins=_allowed_origins(),
            ):
                service.ready = True
                logger.info("Live Room WebSocket service listening on %s:%d", HOST, PORT)
                await stop.wait()
        finally:
            expiry_task.cancel()
            await asyncio.gather(expiry_task, return_exceptions=True)
            await service.shutdown()
            _active_service = None


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
