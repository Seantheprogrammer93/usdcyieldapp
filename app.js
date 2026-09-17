/* Minimal Morpho Earn app — MetaMask + ERC-4626 Morpho Vaults.
   Vaults are standard ERC-4626, so deposits/withdrawals use the standard interface. */

const ERC4626_ABI = [
  "function asset() view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalAssets() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

// A few well-known Ethereum mainnet Morpho Vaults (all ERC-4626).
// Any vault address can also be pasted manually.
const PRESET_VAULTS = [
  { label: "Steakhouse USDC", address: "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB" },
  { label: "Gauntlet USDC Core", address: "0x8eB67A509616cd6A7c1B3c8C21D48FF57df3d458" },
  { label: "Steakhouse USDT", address: "0xbEef047a543E45807105E51A8BBEFCc5950fcfBa" },
];

const MAINNET_CHAIN_ID = 1n;

let provider, signer, account;
let vault, asset, assetDecimals, assetSymbol;

const $ = (id) => document.getElementById(id);

function setStatus(msg, kind = "") {
  const el = $("status");
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}

function short(addr) {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function fmt(value, decimals, digits = 4) {
  const n = Number(ethers.formatUnits(value, decimals));
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

// ---- Wallet ----------------------------------------------------------------

async function connect() {
  if (!window.ethereum) {
    setStatus("MetaMask not detected. Please install it.", "error");
    return;
  }
  try {
    provider = new ethers.BrowserProvider(window.ethereum);

    // When enabled, force MetaMask's extension widget (account picker) to open.
    if ($("openWidgetToggle").checked) {
      await provider.send("wallet_requestPermissions", [{ eth_accounts: {} }]);
    }

    await provider.send("eth_requestAccounts", []);
    signer = await provider.getSigner();
    account = await signer.getAddress();

    const net = await provider.getNetwork();
    $("accountAddr").textContent = short(account);
    $("network").textContent = net.name === "unknown" ? `Chain ${net.chainId}` : net.name;
    $("account").classList.remove("hidden");
    $("connectBtn").classList.add("hidden");
    $("logoutBtn").classList.remove("hidden");

    if (net.chainId !== MAINNET_CHAIN_ID) {
      setStatus("Preset vaults are on Ethereum mainnet — switch network or paste a matching vault.", "error");
    } else {
      setStatus("");
    }

    window.ethereum.on("accountsChanged", () => location.reload());
    window.ethereum.on("chainChanged", () => location.reload());
  } catch (err) {
    setStatus(err.shortMessage || err.message, "error");
  }
}

async function disconnect() {
  // Revoke permissions so the next connect prompts the account picker again.
  try {
    await window.ethereum?.request({
      method: "wallet_revokePermissions",
      params: [{ eth_accounts: {} }],
    });
  } catch (_) {
    // Not all wallets support revoke; ignore and just reset local state.
  }

  provider = signer = account = null;
  vault = asset = null;

  $("account").classList.add("hidden");
  $("vaultInfo").classList.add("hidden");
  $("actions").classList.add("hidden");
  $("logoutBtn").classList.add("hidden");
  $("connectBtn").classList.remove("hidden");
  setStatus("Logged out.");
}

// ---- Vault load ------------------------------------------------------------

async function loadVault() {
  const addr = ($("vaultAddress").value || $("vaultSelect").value).trim();
  if (!ethers.isAddress(addr)) {
    setStatus("Enter a valid vault address.", "error");
    return;
  }
  if (!signer) {
    setStatus("Connect MetaMask first.", "error");
    return;
  }

  try {
    setStatus("Loading vault…");
    vault = new ethers.Contract(addr, ERC4626_ABI, signer);
    const assetAddr = await vault.asset();
    asset = new ethers.Contract(assetAddr, ERC20_ABI, signer);

    const [name, aSym, aDec] = await Promise.all([
      vault.name(),
      asset.symbol(),
      asset.decimals(),
    ]);
    assetSymbol = aSym;
    assetDecimals = Number(aDec);

    $("vaultName").textContent = name;
    $("assetSymbol").textContent = assetSymbol;
    $("vaultInfo").classList.remove("hidden");
    $("actions").classList.remove("hidden");

    await refreshBalances();
    setStatus("");
  } catch (err) {
    setStatus("Could not load vault: " + (err.shortMessage || err.message), "error");
  }
}

async function refreshBalances() {
  const [wallet, shares, total] = await Promise.all([
    asset.balanceOf(account),
    vault.balanceOf(account),
    vault.totalAssets(),
  ]);
  const deposited = await vault.convertToAssets(shares);

  $("walletBalance").textContent = `${fmt(wallet, assetDecimals)} ${assetSymbol}`;
  $("depositBalance").textContent = `${fmt(deposited, assetDecimals)} ${assetSymbol}`;
  $("tvl").textContent = `${fmt(total, assetDecimals, 0)} ${assetSymbol}`;
}

// ---- Actions ---------------------------------------------------------------

async function deposit() {
  const raw = $("depositAmount").value;
  if (!raw || Number(raw) <= 0) return setStatus("Enter an amount.", "error");

  try {
    const amount = ethers.parseUnits(raw, assetDecimals);
    const balance = await asset.balanceOf(account);
    if (amount > balance) return setStatus("Amount exceeds wallet balance.", "error");

    const allowance = await asset.allowance(account, vault.target);
    if (allowance < amount) {
      setStatus("Approving…");
      const txA = await asset.approve(vault.target, amount);
      await txA.wait();
    }

    setStatus("Depositing…");
    const tx = await vault.deposit(amount, account);
    await tx.wait();

    $("depositAmount").value = "";
    await refreshBalances();
    setStatus("Deposit confirmed.", "success");
  } catch (err) {
    setStatus(err.shortMessage || err.message, "error");
  }
}

async function withdraw() {
  const raw = $("withdrawAmount").value;
  if (!raw || Number(raw) <= 0) return setStatus("Enter an amount.", "error");

  try {
    const amount = ethers.parseUnits(raw, assetDecimals);
    const max = await vault.maxWithdraw(account);
    if (amount > max) return setStatus("Amount exceeds your withdrawable balance.", "error");

    setStatus("Withdrawing…");
    const tx = await vault.withdraw(amount, account, account);
    await tx.wait();

    $("withdrawAmount").value = "";
    await refreshBalances();
    setStatus("Withdrawal confirmed.", "success");
  } catch (err) {
    setStatus(err.shortMessage || err.message, "error");
  }
}

async function setMaxDeposit() {
  const balance = await asset.balanceOf(account);
  $("depositAmount").value = ethers.formatUnits(balance, assetDecimals);
}

async function setMaxWithdraw() {
  const max = await vault.maxWithdraw(account);
  $("withdrawAmount").value = ethers.formatUnits(max, assetDecimals);
}

// ---- UI wiring -------------------------------------------------------------

function initPresets() {
  const sel = $("vaultSelect");
  for (const v of PRESET_VAULTS) {
    const opt = document.createElement("option");
    opt.value = v.address;
    opt.textContent = v.label;
    sel.appendChild(opt);
  }
}

function switchTab(tab) {
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === tab)
  );
  $("depositPanel").classList.toggle("hidden", tab !== "deposit");
  $("withdrawPanel").classList.toggle("hidden", tab !== "withdraw");
  setStatus("");
}

function init() {
  initPresets();

  const toggle = $("openWidgetToggle");
  toggle.checked = localStorage.getItem("openWidget") === "1";
  toggle.addEventListener("change", () =>
    localStorage.setItem("openWidget", toggle.checked ? "1" : "0")
  );

  $("connectBtn").addEventListener("click", connect);
  $("logoutBtn").addEventListener("click", disconnect);
  $("loadVaultBtn").addEventListener("click", loadVault);
  $("depositBtn").addEventListener("click", deposit);
  $("withdrawBtn").addEventListener("click", withdraw);
  $("maxDepositBtn").addEventListener("click", setMaxDeposit);
  $("maxWithdrawBtn").addEventListener("click", setMaxWithdraw);
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => switchTab(t.dataset.tab))
  );
}

init();
