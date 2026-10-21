import AuthenticationServices
import Capacitor
import Foundation
import Security
import StoreKit
import UIKit

final class AuxViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(AuxCommercePlugin())
    }
}

/// Apple owns the purchase UI; only the server can grant game credits.
@objc(AuxCommercePlugin)
public final class AuxCommercePlugin: CAPPlugin, CAPBridgedPlugin,
    ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "AuxCommercePlugin"
    public let jsName = "AuxCommerce"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "products", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pendingTransactions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setKeepAwake", returnType: CAPPluginReturnPromise)
    ]

    private struct SavedAccount: Codable, Equatable {
        let token: String
        let appleUserID: String
    }
    private enum SecureStorageError: Error { case unavailable }
    private let keychainService = "com.auxbattles.game.host-session"
    // All mutable plugin state is accessed on the main thread. Apple identity
    // tokens and authorization codes are never persisted on the device.
    private var signInCall: CAPPluginCall?
    private var authorizationController: ASAuthorizationController?
    private var signInWindow: UIWindow?
    private var signInTimeout: DispatchWorkItem?
    private var pendingAppleUserID: String?
    private var shareController: UIActivityViewController?
    private var desiredKeepAwake = false
    private var purchasing = false
    private var checkingCredential = false
    private var updates: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []

    public override func load() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.observers.append(NotificationCenter.default.addObserver(
                forName: ASAuthorizationAppleIDProvider.credentialRevokedNotification,
                object: nil, queue: .main
            ) { [weak self] _ in self?.checkSavedCredential() })
            self.observers.append(NotificationCenter.default.addObserver(
                forName: UIApplication.didBecomeActiveNotification,
                object: nil, queue: .main
            ) { [weak self] _ in
                guard let self else { return }
                UIApplication.shared.isIdleTimerDisabled = self.desiredKeepAwake
                self.checkSavedCredential()
                self.notifyListeners("appActive", data: [:])
            })
            self.observers.append(NotificationCenter.default.addObserver(
                forName: UIApplication.didEnterBackgroundNotification,
                object: nil, queue: .main
            ) { _ in UIApplication.shared.isIdleTimerDisabled = false })
            self.updates = Task { @MainActor [weak self] in
                for await result in Transaction.updates {
                    if Task.isCancelled { break }
                    guard case .verified(let transaction) = result,
                          transaction.productType == .consumable else { continue }
                    self?.notifyListeners("transaction", data: [
                        "transactionId": String(transaction.id),
                        "signedTransaction": result.jwsRepresentation
                    ], retainUntilConsumed: true)
                }
            }
        }
    }

    deinit {
        updates?.cancel()
        signInTimeout?.cancel()
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = false }
    }

    @objc func signIn(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.signInCall == nil else {
                call.reject("Sign in is already running.", "SIGN_IN_BUSY"); return
            }
            guard let nonce = call.getString("nonce"), !nonce.isEmpty, nonce.count <= 256 else {
                call.reject("The sign-in challenge is missing. Please try again.", "INVALID_NONCE"); return
            }
            guard let window = self.bridge?.viewController?.view.window,
                  window.windowScene?.activationState == .foregroundActive else {
                call.reject("Open the app before signing in.", "APP_NOT_ACTIVE"); return
            }
            self.pendingAppleUserID = nil
            self.signInWindow = window
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.nonce = nonce
            self.signInCall = call
            self.bridge?.saveCall(call)
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.authorizationController = controller
            let timeout = DispatchWorkItem { [weak self, weak controller] in
                guard let self, let controller, self.authorizationController === controller else { return }
                self.finishSignIn(error: "Apple sign in took too long. Please try again.", code: "SIGN_IN_TIMEOUT")
                // cancel() is iOS 16+. Clearing the delegate also makes a late
                // completion harmless on iOS 15; its user can dismiss the sheet.
                controller.delegate = nil
                if #available(iOS 16.0, *) { controller.cancel() }
            }
            self.signInTimeout = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + 90, execute: timeout)
            controller.performRequests()
        }
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        signInWindow ?? UIWindow()
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        DispatchQueue.main.async {
            guard self.authorizationController === controller else { return }
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  !credential.user.isEmpty,
                  let identityData = credential.identityToken,
                  let identityToken = String(data: identityData, encoding: .utf8),
                  let codeData = credential.authorizationCode,
                  let authorizationCode = String(data: codeData, encoding: .utf8) else {
                self.finishSignIn(error: "Apple could not complete sign in. Please try again.", code: "SIGN_IN_FAILED")
                return
            }
            self.pendingAppleUserID = credential.user
            self.finishSignIn(payload: ["identityToken": identityToken, "authorizationCode": authorizationCode])
        }
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        DispatchQueue.main.async {
            guard self.authorizationController === controller else { return }
            self.finishSignIn(error: "Apple sign in was cancelled or unavailable.", code: "SIGN_IN_CANCELLED")
        }
    }

    private func finishSignIn(payload: [String: Any]? = nil, error: String? = nil, code: String? = nil) {
        guard let call = signInCall else { return }
        signInTimeout?.cancel()
        signInTimeout = nil
        signInCall = nil
        authorizationController = nil
        signInWindow = nil
        if let payload { call.resolve(payload) }
        else { call.reject(error ?? "Apple sign in failed.", code) }
        bridge?.releaseCall(call)
    }

    @objc func products(_ call: CAPPluginCall) {
        let ids = call.getArray("ids", String.self) ?? []
        guard ids.count <= 64, ids.allSatisfy({ !$0.isEmpty && $0.count <= 255 }) else {
            call.reject("Invalid game pack list.", "INVALID_PRODUCTS"); return
        }
        Task { @MainActor in
            do {
                let products = try await Product.products(for: Set(ids))
                let available = products.filter { $0.type == .consumable }
                call.resolve(["products": available.sorted { $0.id < $1.id }.map {
                    ["id": $0.id, "name": $0.displayName, "price": $0.displayPrice]
                }])
            } catch { call.reject("Game packs are unavailable. Try again later.", "STORE_UNAVAILABLE") }
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard !self.purchasing else {
                call.reject("A purchase is already running.", "PURCHASE_BUSY"); return
            }
            guard let id = call.getString("productId"), !id.isEmpty, id.count <= 255,
                  let rawToken = call.getString("appAccountToken"), let token = UUID(uuidString: rawToken),
                  (try? self.readSavedAccount()) != nil else {
                call.reject("Sign in before purchasing a game pack.", "SIGN_IN_REQUIRED"); return
            }
            guard self.bridge?.viewController?.view.window?.windowScene?.activationState == .foregroundActive else {
                call.reject("Open the app before purchasing a game pack.", "APP_NOT_ACTIVE"); return
            }
            self.purchasing = true
            defer { self.purchasing = false }
            do {
                guard let product = try await Product.products(for: [id]).first, product.type == .consumable else {
                    call.reject("This game pack is unavailable.", "PRODUCT_UNAVAILABLE"); return
                }
                let result = try await product.purchase(options: [.appAccountToken(token)])
                switch result {
                case .success(let verification):
                    guard case .verified(let transaction) = verification else {
                        call.reject("Apple could not verify this purchase.", "PURCHASE_UNVERIFIED"); return
                    }
                    // Never finish until the backend has durably credited it.
                    call.resolve(["status": "purchased", "transactionId": String(transaction.id),
                                  "signedTransaction": verification.jwsRepresentation])
                case .pending: call.resolve(["status": "pending"])
                case .userCancelled: call.resolve(["status": "cancelled"])
                @unknown default: call.reject("This purchase could not be completed.", "PURCHASE_FAILED")
                }
            } catch { call.reject("The purchase could not be completed. Please try again.", "PURCHASE_FAILED") }
        }
    }

    @objc func pendingTransactions(_ call: CAPPluginCall) {
        Task { @MainActor in
            var transactions: [[String: String]] = []
            for await result in Transaction.unfinished {
                if case .verified(let transaction) = result, transaction.productType == .consumable {
                    transactions.append(["transactionId": String(transaction.id), "signedTransaction": result.jwsRepresentation])
                }
            }
            call.resolve(["transactions": transactions])
        }
    }

    @objc func finishTransaction(_ call: CAPPluginCall) {
        guard let id = call.getString("transactionId"), UInt64(id) != nil else {
            call.reject("Invalid purchase identifier.", "INVALID_TRANSACTION"); return
        }
        Task { @MainActor in
            for await result in Transaction.unfinished {
                if case .verified(let transaction) = result,
                   transaction.productType == .consumable, String(transaction.id) == id {
                    await transaction.finish()
                    break
                }
            }
            // Finishing a previously finished purchase is an idempotent success.
            call.resolve()
        }
    }

    @objc func share(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.shareController == nil else {
                call.reject("The share sheet is already open.", "SHARE_BUSY"); return
            }
            guard let presenter = self.bridge?.viewController,
                  let window = presenter.view.window,
                  window.windowScene?.activationState == .foregroundActive,
                  presenter.presentedViewController == nil else {
                call.reject("Close the current screen before sharing.", "APP_NOT_ACTIVE"); return
            }
            let text = call.getString("text") ?? ""
            guard text.count <= 4000 else {
                call.reject("The invitation is too long.", "INVALID_SHARE"); return
            }
            var items: [Any] = []
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { items.append(text) }
            if let rawURL = call.getString("url") {
                guard rawURL.count <= 2000,
                      let components = URLComponents(string: rawURL),
                      let scheme = components.scheme?.lowercased(), ["https", "http"].contains(scheme),
                      let host = components.host, !host.isEmpty,
                      components.user == nil, components.password == nil,
                      let url = components.url else {
                    call.reject("Use a valid web invitation link.", "INVALID_SHARE_URL"); return
                }
                items.append(url)
            }
            guard !items.isEmpty else {
                call.reject("Add an invitation to share.", "INVALID_SHARE"); return
            }
            let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
            if let popover = controller.popoverPresentationController {
                popover.sourceView = presenter.view
                popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
                popover.permittedArrowDirections = []
            }
            self.shareController = controller
            self.bridge?.saveCall(call)
            controller.completionWithItemsHandler = { [weak self, weak controller] _, completed, _, error in
                DispatchQueue.main.async {
                    guard let self, let controller, self.shareController === controller else { return }
                    self.shareController = nil
                    if error != nil { call.reject("The invitation could not be shared.", "SHARE_FAILED") }
                    else { call.resolve(["status": completed ? "completed" : "cancelled"]) }
                    self.bridge?.releaseCall(call)
                }
            }
            presenter.present(controller, animated: true)
        }
    }

    @objc func setKeepAwake(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.desiredKeepAwake = call.getBool("enabled") ?? false
            UIApplication.shared.isIdleTimerDisabled = self.desiredKeepAwake && UIApplication.shared.applicationState == .active
            call.resolve()
        }
    }

    @objc func loadSession(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.checkSavedCredential(call: call) }
    }

    /// A transient Apple/Keychain error preserves the saved session. Only a
    /// definite invalid credential removes it; a stale callback cannot erase a
    /// newer sign-in that completed while Apple's check was in flight.
    private func checkSavedCredential(call: CAPPluginCall? = nil) {
        if call == nil && (checkingCredential || signInCall != nil) { return }
        let saved: SavedAccount
        do {
            guard let current = try readSavedAccount() else { call?.resolve([:]); return }
            saved = current
        } catch {
            call?.reject("Could not read the saved account. Unlock your iPhone and try again.", "SECURE_STORAGE_UNAVAILABLE")
            return
        }
        checkingCredential = true
        var completed = false
        let timeout = DispatchWorkItem { [weak self] in
            guard !completed else { return }
            completed = true
            self?.checkingCredential = false
            call?.reject("Apple sign-in check took too long. Please try again.", "APPLE_CREDENTIAL_UNAVAILABLE")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: timeout)
        ASAuthorizationAppleIDProvider().getCredentialState(forUserID: saved.appleUserID) { [weak self] state, error in
            DispatchQueue.main.async {
                guard !completed else { return }
                completed = true
                timeout.cancel()
                guard let self else { return }
                self.checkingCredential = false
                do {
                    guard try self.readSavedAccount() == saved else { call?.resolve([:]); return }
                    // Apple's documented .notFound result can include an error;
                    // revoked/notFound/transferred take precedence over that error.
                    switch state {
                    case .revoked, .notFound, .transferred:
                        try self.clearSavedAccount()
                        self.pendingAppleUserID = nil
                        self.notifyListeners("accountRevoked", data: ["reason": "apple_credential_revoked"], retainUntilConsumed: true)
                        call?.resolve([:])
                    case .authorized:
                        if error != nil {
                            call?.reject("Could not check Apple sign in. Please try again.", "APPLE_CREDENTIAL_UNAVAILABLE")
                        } else { call?.resolve(["token": saved.token]) }
                    @unknown default:
                        call?.reject("Please sign in with Apple again.", "APPLE_CREDENTIAL_UNAVAILABLE")
                    }
                } catch {
                    call?.reject("Could not update the saved account. Please try again.", "SECURE_STORAGE_UNAVAILABLE")
                }
            }
        }
    }

    @objc func saveSession(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let token = call.getString("token") ?? ""
            do {
                if token.isEmpty {
                    try self.clearSavedAccount()
                    self.pendingAppleUserID = nil
                } else {
                    guard token.count >= 32, token.count <= 256 else {
                        call.reject("Invalid host session.", "INVALID_SESSION"); return
                    }
                    let previous = try self.readSavedAccount()
                    guard let appleUserID = self.pendingAppleUserID ?? previous?.appleUserID else {
                        call.reject("Sign in with Apple before saving your account.", "SIGN_IN_REQUIRED"); return
                    }
                    try self.writeSavedAccount(SavedAccount(token: token, appleUserID: appleUserID))
                    self.pendingAppleUserID = nil
                }
                call.resolve()
            } catch { call.reject("Could not save the account securely. Please try again.", "SECURE_STORAGE_UNAVAILABLE") }
        }
    }

    private var keychainQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: keychainService, kSecAttrAccount as String: "host",
         kSecAttrSynchronizable as String: false]
    }

    private func readSavedAccount() throws -> SavedAccount? {
        var query = keychainQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw SecureStorageError.unavailable }
        guard data.count <= 4096,
              let account = try? JSONDecoder().decode(SavedAccount.self, from: data),
              !account.token.isEmpty, !account.appleUserID.isEmpty else {
            // Development builds previously stored only a raw bearer token. A
            // fresh Apple sign-in migrates safely instead of inventing an ID.
            try clearSavedAccount()
            return nil
        }
        return account
    }

    private func writeSavedAccount(_ account: SavedAccount) throws {
        let attributes: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(account),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let updated = SecItemUpdate(keychainQuery as CFDictionary, attributes as CFDictionary)
        if updated == errSecItemNotFound {
            let item = keychainQuery.merging(attributes) { _, new in new }
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw SecureStorageError.unavailable }
        } else if updated != errSecSuccess { throw SecureStorageError.unavailable }
    }

    private func clearSavedAccount() throws {
        let status = SecItemDelete(keychainQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw SecureStorageError.unavailable }
    }
}
