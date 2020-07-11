const { Pool } = require("pg");

// src.database
const TableUTokens = require("./database/tableutokens");
const TableCTokens = require("./database/tablectokens");
const TablePaySeizePairs = require("./database/tablepayseizepairs");
const TableUsers = require("./database/tableusers");
// src.network.web
const AccountService = require("./network/web/compound/accountservice");
const CTokenService = require("./network/web/compound/ctokenservice");
const GasPrice = require("./network/web/gasstation/gasprice");
// src.network.webthree
const EthAccount = require("./network/webthree/ethaccount");
const Comptroller = require("./network/webthree/compound/comptroller");
const Tokens = require("./network/webthree/compound/ctoken");

new EthAccount();

class Main {
  constructor() {
    if (!Main.shared) {
      // Database is assumed to have already been setup & initialized
      this._pool = new Pool({
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000
      });

      this._tableUTokens = new TableUTokens(this._pool);
      this._tableCTokens = new TableCTokens(this._pool, this._tableUTokens);
      this._tablePaySeizePairs = new TablePaySeizePairs(
        this._pool,
        this._tableCTokens
      );
      this._tableUsers = new TableUsers(
        this._pool,
        this._tableCTokens,
        this._tablePaySeizePairs
      );

      this._accountService = new AccountService();
      this._ctokenService = new CTokenService();
      this._gasPriceAPI = new GasPrice();

      this._blockLastAccountServicePull = null;
      this._blocksPerMinute = 0;

      this._liquidationTargets = [];

      Main.shared = this;
    }
  }

  static async pullFromCTokenService() {
    const self = Main.shared;

    const tokens = (await self._ctokenService.fetch({})).tokens;
    await self._tableUTokens.upsertCTokenService(tokens);
    await self._tableCTokens.upsertCTokenService(tokens);
    await self._tablePaySeizePairs.insertCTokenService(tokens);
  }

  static async pullFromAccountService(timeout_minutes, offset_minutes) {
    const self = Main.shared;

    const blockCurrent = await web3.eth.getBlockNumber();
    const blockToLabel = blockCurrent - offset_minutes * self._blocksPerMinute;
    const closeFactor = await Comptroller.mainnet.closeFactor();
    const liquidationIncentive = await Comptroller.mainnet.liquidationIncentive();

    // 0 means pull most recent block
    // We label it with an older block number to avoid overwriting fresher
    // data from on-chain calls
    self._accountService.fetchAll(0, accounts => {
      self._tableUsers.upsertAccountService(
        blockToLabel,
        accounts,
        closeFactor,
        liquidationIncentive
      );
    });

    if (self._blockLastAccountServicePull !== null) {
      self._blocksPerMinute =
        (blockCurrent - self._blockLastAccountServicePull) / timeout_minutes;
    }
    self._blockLastAccountServicePull = blockCurrent;
  }

  static async updateLiquidationCandidates(
    lowCount = 10,
    highCount = 90,
    highThresh_Eth = 50
  ) {
    const self = Main.shared;

    const estimatedTxFee_Eth =
      ((await web3.eth.getGasPrice()) / 1e18) * 1000000;

    self._liquidationTargets = []
      .concat(
        await self._tableUsers.getLiquidationCandidates(
          lowCount,
          estimatedTxFee_Eth
        )
      )
      .concat(
        await self._tableUsers.getLiquidationCandidates(
          highCount,
          highThresh_Eth
        )
      );
  }

  static async onNewBlock() {
    const self = Main.shared;

    const gasPrice = await web3.eth.getGasPrice();
    for (let target of self._liquidationTargets) {
      const userAddr = "0x" + target.address;
      Comptroller.mainnet.accountLiquidityOf(userAddr).then(async res => {
        if (res[1] > 0.0) {
          // Target has negative liquidity (positive shortfall). We're good to go
          const repayAddr =
            "0x" +
            (await self._tableCTokens.getAddress(target.ctokenidpay));
          const seizeAddr =
            "0x" +
            (await self._tableCTokens.getAddress(target.ctokenidseize));

          const closeFact = await Comptroller.mainnet.closeFactor();
          const repayAmnt =
            closeFact *
            1e18 *
            (await Tokens.mainnetByAddr[repayAddr].uUnitsLoanedOutTo(userAddr));

          console.log("Liquidating " + userAddr);
          const tx = Tokens.mainnetByAddr[repayAddr].flashLiquidate_uUnits(
            userAddr,
            repayAmnt,
            seizeAddr,
            gasPrice
          );

          EthAccount.shared.signAndSend(
            tx,
            await EthAccount.getHighestConfirmedNonce()
          );
        }
      });
    }
  }

  end() {
    this._pool.end();
  }
}

module.exports = Main;
