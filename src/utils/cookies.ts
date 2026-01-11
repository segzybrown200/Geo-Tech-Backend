import { Response } from "express";

export const setSessionCookie = (res: Response, token: string) => {
  res.cookie("geo_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,   
    maxAge: 24 * 60 * 60 * 1000, // 24 hrs
    path: "/",
  });
};

export const clearSessionCookie = (res: Response) => {
  res.clearCookie("geo_session", {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    path: "/",
  });
};
