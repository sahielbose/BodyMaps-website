"""room.ready carries the server's time so clients can correct their own clock."""
from __future__ import annotations

import asyncio
import json
from datetime import datetime

from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from live_rooms_ws import LiveRoomWebSocketService

from .test_live_quiz import quiz_store  # noqa: F401  (pytest fixture)


def test_room_ready_carries_the_server_time(quiz_store):  # noqa: F811
    store, _ = quiz_store
    metadata, key, host_claim = store.create_quiz_room("35", "low")

    async def scenario():
        service = LiveRoomWebSocketService(store)
        async with serve(service.handler, "127.0.0.1", 0, max_size=512 * 1024) as server:
            port = server.sockets[0].getsockname()[1]
            async with connect(f"ws://127.0.0.1:{port}/ws/live-rooms/{metadata['room_id']}") as host:
                await host.send(json.dumps({
                    "type": "hello", "protocol": 1, "room_key": key,
                    "quiz_host_claim": host_claim, "name": "Host", "last_seq": 0,
                }))
                ready = json.loads(await host.recv())
                assert ready["type"] == "room.ready"
                assert datetime.fromisoformat(ready["at"]).tzinfo is not None

    asyncio.run(scenario())
