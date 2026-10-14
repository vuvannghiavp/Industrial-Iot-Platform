from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status

from app.core.security import decode_token

router = APIRouter(tags=["realtime"])


@router.websocket("/ws/telemetry")
async def telemetry_websocket(websocket: WebSocket) -> None:
    """Authenticated stream of MQTT telemetry and alert events.

    Authenticate with the `bearer` WebSocket subprotocol followed by the access JWT.
    """
    offered_protocols = [
        protocol.strip()
        for protocol in websocket.headers.get("sec-websocket-protocol", "").split(",")
        if protocol.strip()
    ]
    token = offered_protocols[1] if len(offered_protocols) == 2 and offered_protocols[0] == "bearer" else ""
    try:
        decode_token(token)
    except Exception:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    manager = websocket.app.state.websocket_manager
    await manager.connect(websocket, subprotocol="bearer")
    try:
        while True:
            # Keeping a receive loop allows clients to send ping messages and
            # makes disconnect detection immediate; no client data is trusted.
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
