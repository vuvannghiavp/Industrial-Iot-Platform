from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm

from app.api.dependencies import CurrentUser, DbSession
from app.api.schemas import RefreshRequest, TokenPair, UserRead
from app.core.security import create_token, decode_token, verify_password
from app.models import User

router = APIRouter(prefix="/auth", tags=["authentication"])


def token_pair(user: User) -> TokenPair:
    return TokenPair(
        access_token=create_token(str(user.id), user.role, "access"),
        refresh_token=create_token(str(user.id), user.role, "refresh"),
    )


@router.post("/login", response_model=TokenPair)
def login(form: Annotated[OAuth2PasswordRequestForm, Depends()], db: DbSession) -> TokenPair:
    # OAuth2 form uses `username`; clients submit their email in that field.
    user = db.query(User).filter(User.email == form.username).first()
    if user is None or not user.is_active or not verify_password(form.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")
    return token_pair(user)


@router.post("/refresh", response_model=TokenPair)
def refresh(request: RefreshRequest, db: DbSession) -> TokenPair:
    payload = decode_token(request.refresh_token, expected_type="refresh")
    user = db.get(User, int(payload["sub"]))
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Inactive or unknown user")
    return token_pair(user)


@router.get("/me", response_model=UserRead)
def me(current_user: CurrentUser) -> User:
    return current_user
