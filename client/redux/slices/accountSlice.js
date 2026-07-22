import { createSlice } from '@reduxjs/toolkit';

import { api } from '../api';

const accountSlice = createSlice({
    name: 'account',
    initialState: {},
    reducers: {
        clearLinkStatus: (state) => {
            state.accountLinked = undefined;
        },
        // ARCHON: populate the account user directly. Used by the SSO redirect,
        // which mints its tokens client-side (from the URL fragment) rather
        // than through the loginAccount mutation, so no RTK matcher fires to
        // set state.account.user. Without this the whole app reads an
        // undefined user after SSO (stuck on "Loading...", logged-out nav).
        setUser: (state, action) => {
            state.loggedIn = true;
            state.loggedOut = false;
            state.user = action.payload;
        }
    },
    extraReducers: (builder) => {
        builder
            .addMatcher(api.endpoints.registerAccount.matchPending, (state) => {
                state.registered = false;
            })
            .addMatcher(api.endpoints.registerAccount.matchFulfilled, (state) => {
                state.registered = true;
            })
            .addMatcher(api.endpoints.loginAccount.matchPending, (state) => {
                state.loggedIn = false;
            })
            .addMatcher(api.endpoints.loginAccount.matchFulfilled, (state, action) => {
                state.loggedIn = true;
                state.loggedOut = false;
                state.user = action.payload.user;
            })
            .addMatcher(api.endpoints.logoutAccount.matchFulfilled, (state) => {
                state.loggedIn = false;
                state.loggedOut = true;
                state.user = undefined;
            })
            .addMatcher(api.endpoints.resetPassword.matchPending, (state) => {
                state.passwordReset = false;
            })
            .addMatcher(api.endpoints.resetPassword.matchFulfilled, (state) => {
                state.passwordReset = true;
            })
            .addMatcher(api.endpoints.activateAccount.matchPending, (state) => {
                state.activated = false;
            })
            .addMatcher(api.endpoints.activateAccount.matchFulfilled, (state) => {
                state.activated = true;
            })
            .addMatcher(api.endpoints.verifyAuthentication.matchFulfilled, (state, action) => {
                state.loggedIn = true;
                state.user = action.payload.user;
            })
            .addMatcher(api.endpoints.saveProfile.matchFulfilled, (state, action) => {
                state.user = action.payload.user;
            })
            .addMatcher(api.endpoints.deleteAccount.matchFulfilled, (state) => {
                state.loggedIn = false;
                state.loggedOut = true;
                state.user = undefined;
            })
            .addMatcher(api.endpoints.linkPatreon.matchFulfilled, (state) => {
                state.accountLinked = true;
            })
            .addMatcher(api.endpoints.unlinkPatreon.matchFulfilled, (state) => {
                state.accountLinked = undefined;
                if (state.user) {
                    state.user.patreon = undefined;
                }
            })
            // ARCHON: first-run onboarding wizard (Phase 9)
            .addMatcher(api.endpoints.completeOnboarding.matchFulfilled, (state) => {
                if (state.user) {
                    state.user.onboarded = true;
                }
            })
            .addMatcher(api.endpoints.setAvatar.matchFulfilled, (state, action) => {
                if (state.user && action.payload.avatar) {
                    state.user.avatar = action.payload.avatar;
                    // Keep settings.avatar in sync too - components read from
                    // both, so updating only the top-level field left the
                    // avatar stale in places until the next auth refresh.
                    if (state.user.settings) {
                        state.user.settings.avatar = action.payload.avatar;
                    }
                }
            });
    }
});

export const accountActions = accountSlice.actions;
export default accountSlice.reducer;
