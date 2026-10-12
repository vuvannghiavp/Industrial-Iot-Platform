from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status

from app.core.security import decode_token

router = APIRouter(tags=["realtime"])


@router.websocket("/ws/telemetry")
async def telemetry_websocket(websocket: WebSocket) -> None:
    """Authenticated stream of MQTT telemetry and alert events.

    Connect with `ws://host/ws/telemetry?token=<access JWT>`.
    """
    token = websocket.query_params.get("token")
    try:
        decode_token(token or "")
    except Exception:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    manager = websocket.app.state.websocket_manager
    await manager.connect(websocket)
    try:
        while True:
            # Keeping a receive loop allows clients to send ping messages and
            # makes disconnect detection immediate; no client data is trusted.
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
