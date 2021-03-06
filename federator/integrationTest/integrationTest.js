const fs = require("fs");
const Web3 = require("web3");
const log4js = require("log4js");

//configurations
// the following file should only be used for integration tests
const config = require("../config/test.local.config.js");
const logConfig = require("../config/log-config.json");
const abiBridge = require("../../bridge/abi/Bridge.json");
const abiMainToken = require("../../bridge/abi/MainToken.json");
const abiSideToken = require("../../bridge/abi/SideToken.json");
const abiAllowTokens = require("../../bridge/abi/AllowTokens.json");
const abiMultiSig = require("../../bridge/abi/MultiSigWallet.json");

//utils
const TransactionSender = require("../src/lib/TransactionSender.js");
const Federator = require("../src/lib/Federator.js");
const utils = require("../src/lib/utils.js");
const fundFederators = require("./fundFederators");
const MSG_TOKEN_NOT_VOTED = "Token was not voted by federators";

const destinationTokenBytecode = fs.readFileSync(
  `${__dirname}/sideTokenBytecode.txt`,
  "utf8"
);

const logger = log4js.getLogger("test");
log4js.configure(logConfig);
logger.info("----------- Transfer Test ---------------------");
logger.info("Mainchain Host", config.mainchain.host);
logger.info("Sidechain Host", config.sidechain.host);

const sideConfig = {
  ...config,
  confirmations: 0,
  mainchain: config.sidechain,
  sidechain: config.mainchain,
};

const mainKeys = process.argv[2]
  ? process.argv[2].replace(/ /g, "").split(",")
  : [];
const sideKeys = process.argv[3]
  ? process.argv[3].replace(/ /g, "").split(",")
  : [];

const mainchainFederators = getFederators(config, mainKeys);
const sidechainFederators = getFederators(sideConfig, sideKeys, "side-fed");

const ONE_DAY_IN_SECONDS = 24 * 3600;
const SIDE_TOKEN_SYMBOL = "MAIN";
const SIDE_TOKEN_NAME = "MAIN";
const MAIN_CHAIN_LOGGER_NAME = "MAIN";
const SIDE_CHAIN_LOGGER_NAME = "SIDE";
const SIDE_TOKEN_TYPE_ID = 0;
const SIDE_TOKEN_DECIMALS = 18;

run(mainchainFederators, sidechainFederators, config, sideConfig);

function getFederators(configFile, keys, storagePathPrefix = "fed") {
  const federators = [];
  if (keys && keys.length) {
    keys.forEach((key, i) => {
      const federator = new Federator(
        {
          ...configFile,
          privateKey: key,
          storagePath: `${configFile.storagePath}/${storagePathPrefix}-${
            i + 1
          }`,
        },
        log4js.getLogger("FEDERATOR")
      );
      federators.push(federator);
    });
  } else {
    federators.push(
      new Federator(
        {
          ...configFile,
          storagePath: `${config.storagePath}/${storagePathPrefix}`,
        },
        log4js.getLogger("FEDERATOR")
      )
    );
  }
  return federators;
}

async function run(
  originFederators,
  destinationFederators,
  originConfig,
  destinationConfig
) {
  logger.info("Starting transfer from Mainchain to Sidechain");
  await transfer(
    originFederators,
    destinationFederators,
    originConfig,
    MAIN_CHAIN_LOGGER_NAME,
    SIDE_CHAIN_LOGGER_NAME
  );
  logger.info("Completed transfer from Mainchain to Sidechain");

  logger.info("Starting transfer from Sidechain to Mainchain");
  const invertOriginFederators = destinationFederators;
  const invertDestinationFederators = originFederators;
  await transfer(
    invertOriginFederators,
    invertDestinationFederators,
    destinationConfig,
    SIDE_CHAIN_LOGGER_NAME,
    MAIN_CHAIN_LOGGER_NAME
  );
  logger.info("Completed transfer from Sidechain to Mainchain");
}

async function checkAddressBalance(tokenContract, userAddress, loggerName) {
  const balance = await tokenContract.methods.balanceOf(userAddress).call();
  logger.info(`${loggerName} token balance`, balance);
  if (balance.toString() === "0") {
    logger.error("Token was not claimed");
    process.exit(1);
  }
}

async function checkTxDataHash(bridgeContract, receipt) {
  const txDataHash = await bridgeContract.methods
    .transactionsDataHashes(receipt.transactionHash)
    .call();
  if (txDataHash === utils.zeroHash) {
    logger.error(MSG_TOKEN_NOT_VOTED);
    process.exit(1);
  }
}

async function sendFederatorTx(
  multiSigAddr,
  multiSigContract,
  tokenAddr,
  dataAbi,
  federatorKeys,
  transactionSender
) {
  const multiSigSubmitData = multiSigContract.methods
    .submitTransaction(tokenAddr, 0, dataAbi)
    .encodeABI();

  if (federatorKeys.length === 1) {
    await transactionSender.sendTransaction(
      multiSigAddr,
      multiSigSubmitData,
      0,
      "",
      true
    );
  } else {
    await transactionSender.sendTransaction(
      multiSigAddr,
      multiSigSubmitData,
      0,
      federatorKeys[0],
      true
    );

    const nextTransactionCount = await multiSigContract.methods
      .getTransactionCount(true, false)
      .call();
    for (let i = 1; i < federatorKeys.length; i++) {
      const multiSigConfirmTxData = multiSigContract.methods
        .confirmTransaction(nextTransactionCount)
        .encodeABI();
      await transactionSender.sendTransaction(
        multiSigAddr,
        multiSigConfirmTxData,
        0,
        federatorKeys[i],
        true
      );
    }
  }
}

async function transferReceiveTokensOtherSide({
  destinationBridgeContract,
  destinationChainId,
  originChainId,
  originReceiptSendTransaction,
  originUserAddress,
  amount,
  destinationTransactionSender,
  destinationBridgeAddress,
  originUserPrivateKey,
  destinationLoggerName,
  destinationTokenContract,
  originChainWeb3,
}) {
  await checkTxDataHash(
    destinationBridgeContract,
    originReceiptSendTransaction
  );

  logger.info("claimTokensFromDestinationBridge init");
  await claimTokensFromDestinationBridge({
    destinationBridgeContract,
    originChainId,
    originUserAddress,
    amount,
    originReceiptSendTransaction,
    destinationTransactionSender,
    destinationBridgeAddress,
    originUserPrivateKey,
  });
  logger.info("claimTokensFromDestinationBridge finish");

  logger.debug("Check balance on the other side");
  await checkAddressBalance(
    destinationTokenContract,
    originUserAddress,
    destinationLoggerName
  );

  const crossCompletedBalance = await originChainWeb3.eth.getBalance(
    originUserAddress
  );
  logger.debug(
    "One way cross user balance (ETH or RBTC)",
    crossCompletedBalance
  );
}

function checkBalance(currentBalance, expectedBalance) {
  if (expectedBalance !== BigInt(currentBalance)) {
    logger.error(
      `Wrong balance. Expected ${expectedBalance} but got ${currentBalance}`
    );
    process.exit(1);
  }
}

async function getUsersBalances(
  originTokenContract,
  destinationTokenContract,
  originBridgeAddress,
  userAddress
) {
  const bridgeBalance = await originTokenContract.methods
    .balanceOf(originBridgeAddress)
    .call();
  const receiverBalance = await originTokenContract.methods
    .balanceOf(userAddress)
    .call();
  const senderBalance = await destinationTokenContract.methods
    .balanceOf(userAddress)
    .call();
  logger.debug(
    `bridge balance:${bridgeBalance}, receiver balance:${receiverBalance}, sender balance:${senderBalance} `
  );
  return {
    bridgeBalance,
    receiverBalance,
    senderBalance,
  };
}

async function runFederators(federators) {
  await federators.reduce(function (promise, item) {
    return promise.then(function () {
      return item.run();
    });
  }, Promise.resolve());
}

async function transferBackTokens({
  destinationTokenContract,
  originUserAddress,
  destinationTransactionSender,
  configChain,
  destinationBridgeAddress,
  amount,
  originTokenAddress,
  destinationTokenAddress,
  originUserPrivateKey,
  originMultiSigContract,
  destinationMultiSigContract,
  destinationAllowTokensAddress,
  federatorPrivateKeys,
  destinationBridgeContract,
  destinationChainId,
  originChainId,
  originChainWeb3,
  destinationFederators,
}) {
  await destinationTransactionSender.sendTransaction(
    originUserAddress,
    "",
    6000000,
    configChain.privateKey,
    true
  );

  logger.debug("Approving token transfer on destination");
  const dataApproveAbi = destinationTokenContract.methods
    .approve(destinationBridgeAddress, amount)
    .encodeABI();
  await destinationTransactionSender.sendTransaction(
    destinationTokenAddress,
    dataApproveAbi,
    0,
    originUserPrivateKey,
    true
  );
  logger.debug("Token transfer approved");
  const allowed = await destinationTokenContract.methods
    .allowance(originUserAddress, destinationBridgeAddress)
    .call();
  logger.debug("Allowed to transfer ", allowed);
  logger.debug("Set side token limit");

  await sendFederatorTx(
    configChain.sidechain.multiSig,
    destinationMultiSigContract,
    destinationAllowTokensAddress,
    dataApproveAbi,
    federatorPrivateKeys,
    destinationTransactionSender
  );

  const sideTokenAddress = await destinationBridgeContract.methods
    .sideTokenByOriginalToken(originChainId, originTokenAddress)
    .call();

  logger.debug("Bridge side receiveTokens");
  const destinationReceiptReceiveTokensTo = await callReceiveTokens({
    bridgeContract: destinationBridgeContract,
    chainId: originChainId,
    tokenAddress: sideTokenAddress,
    originUserAddress,
    userAmount: amount,
    bridgeAddress: destinationBridgeAddress,
    transactionSender: destinationTransactionSender,
    userPrivateKey: originUserPrivateKey,
  });
  logger.debug("Bridge side receiveTokens completed");
  logger.debug("Starting federator processes");
  logger.debug("Fund federator wallets");

  federatorPrivateKeys =
    sideKeys && sideKeys.length ? sideKeys : [configChain.privateKey];
  await fundFederators(
    configChain.mainchain.host,
    federatorPrivateKeys,
    configChain.mainchain.privateKey,
    originChainWeb3.utils.toWei("1")
  );

  logger.warn(
    "`------------- It will start the runFederators of the destinationFederators -------------`,"
  );
  await runFederators(destinationFederators);
  return destinationReceiptReceiveTokensTo;
}

async function callReceiveTokens({
  bridgeContract,
  chainId,
  tokenAddress,
  originUserAddress,
  userAmount,
  bridgeAddress,
  transactionSender,
  userPrivateKey,
}) {
  const methodCallReceiveTokensTo = bridgeContract.methods.receiveTokensTo(
    chainId,
    tokenAddress,
    originUserAddress,
    userAmount
  );
  const receipt = await methodCallReceiveTokensTo.call({
    from: originUserAddress,
  });
  logger.warn("callReceiveTokens call receipt", receipt);
  return transactionSender.sendTransaction(
    bridgeAddress,
    methodCallReceiveTokensTo.encodeABI(),
    0,
    userPrivateKey,
    true
  );
}

async function callAllReceiveTokens({
  userSmallAmount,
  userMediumAmount,
  userLargeAmount,
  destinationChainId,
  originChainId,
  originBridgeContract,
  originAnotherTokenAddress,
  originUserAddress,
  originBridgeAddress,
  originTransactionSender,
  originUserPrivateKey,
}) {
  logger.warn("callAllReceiveTokens callReceiveTokens small amount init");
  // Cross AnotherToken (type id 0) Small Amount < toWei('0.01')
  const smallAmountReceipt = await callReceiveTokens({
    bridgeContract: originBridgeContract,
    chainId: destinationChainId,
    tokenAddress: originAnotherTokenAddress,
    originUserAddress,
    userAmount: userSmallAmount,
    bridgeAddress: originBridgeAddress,
    transactionSender: originTransactionSender,
    userPrivateKey: originUserPrivateKey,
  });
  logger.warn("callAllReceiveTokens callReceiveTokens small amount finish");

  // Cross AnotherToken (type id 0) Medium Amount >= toWei('0.01') && < toWei('0.1')
  const mediumAmountReceipt = await callReceiveTokens({
    bridgeContract: originBridgeContract,
    chainId: destinationChainId,
    tokenAddress: originAnotherTokenAddress,
    originUserAddress,
    userAmount: userMediumAmount,
    bridgeAddress: originBridgeAddress,
    transactionSender: originTransactionSender,
    userPrivateKey: originUserPrivateKey,
  });

  // Cross AnotherToken (type id 0) Large Amount >= toWei('0.1')
  const largeAmountReceipt = await callReceiveTokens({
    bridgeContract: originBridgeContract,
    chainId: destinationChainId,
    tokenAddress: originAnotherTokenAddress,
    originUserAddress,
    userAmount: userLargeAmount,
    bridgeAddress: originBridgeAddress,
    transactionSender: originTransactionSender,
    userPrivateKey: originUserPrivateKey,
  });

  return {
    smallAmountReceipt,
    mediumAmountReceipt,
    largeAmountReceipt,
  };
}

async function tranferCheckAmountsGetDestinationBalance({
  originAllowTokensContract,
  configChain,
  originMultiSigContract,
  originAllowTokensAddress,
  cowAddress,
  originChainWeb3,
  originAnotherTokenContract,
  originUserAddress,
  amount,
  originTransactionSender,
  originAnotherTokenAddress,
  originUserPrivateKey,
  destinationTokenContract,
  destinationLoggerName,
  destinationBridgeContract,
  destinationChainId,
  originChainId,
  destinationChainWeb3,
}) {
  logger.info(
    "------------- SMALL, MEDIUM and LARGE amounts are processed after required confirmations  -----------------"
  );

  await originAllowTokensContract.methods
    .setConfirmations("100", "1000", "2000")
    .call({ from: configChain.mainchain.multiSig });
  const dataTransferSetConfirmations = originAllowTokensContract.methods
    .setConfirmations("100", "1000", "2000")
    .encodeABI();

  const methodCallSetConfirmations =
    originMultiSigContract.methods.submitTransaction(
      originAllowTokensAddress,
      0,
      dataTransferSetConfirmations
    );
  await methodCallSetConfirmations.call({ from: cowAddress });
  await methodCallSetConfirmations.send({ from: cowAddress, gas: 500000 });

  await utils.evm_mine(1, originChainWeb3);
  const confirmations = await originAllowTokensContract.methods
    .getConfirmations()
    .call();

  const dataMintAbi = originAnotherTokenContract.methods
    .mint(originUserAddress, amount, "0x", "0x")
    .encodeABI();
  await originTransactionSender.sendTransaction(
    originAnotherTokenAddress,
    dataMintAbi,
    0,
    originUserPrivateKey,
    true
  );
  const remainingUserBalance = await originChainWeb3.eth.getBalance(
    originUserAddress
  );
  logger.debug(
    "user native token balance before crossing tokens:",
    remainingUserBalance
  );

  const userBalanceAnotherToken = await originAnotherTokenContract.methods
    .balanceOf(originUserAddress)
    .call();
  logger.debug("user balance before crossing tokens:", userBalanceAnotherToken);
  let balance = await destinationTokenContract.methods
    .balanceOf(originUserAddress)
    .call();
  logger.info(
    `${destinationLoggerName} token balance before crossing`,
    balance
  );

  const anotherTokenOriginalAddr = await destinationBridgeContract.methods
    .sideTokenByOriginalToken(originChainId, originAnotherTokenAddress)
    .call();
  logger.info(
    `${destinationLoggerName} token address`,
    anotherTokenOriginalAddr
  );
  if (anotherTokenOriginalAddr === utils.zeroAddress) {
    logger.error(MSG_TOKEN_NOT_VOTED);
    process.exit(1);
  }

  logger.debug("Check balance on the other side before crossing");
  const destinationSideTokenContract = new destinationChainWeb3.eth.Contract(
    abiSideToken,
    anotherTokenOriginalAddr
  );
  balance = await destinationSideTokenContract.methods
    .balanceOf(originUserAddress)
    .call();
  logger.info(`${destinationLoggerName} token balance`, balance);

  return {
    confirmations,
    destinationSideTokenContract,
    balance,
  };
}

async function tranferCheckAmounts({
  originAllowTokensContract,
  configChain,
  originMultiSigContract,
  originAllowTokensAddress,
  cowAddress,
  originChainWeb3,
  originAnotherTokenContract,
  originUserAddress,
  amount,
  originTransactionSender,
  originAnotherTokenAddress,
  originUserPrivateKey,
  destinationTokenContract,
  destinationLoggerName,
  destinationBridgeContract,
  destinationChainId,
  destinationChainWeb3,
  originBridgeAddress,
  originBridgeContract,
  originChainId,
  originFederators,
  destinationTransactionSender,
  destinationBridgeAddress,
}) {
  const {
    confirmations,
    destinationSideTokenContract,
    balance: destinationInitialUserBalance,
  } = await tranferCheckAmountsGetDestinationBalance({
    originAllowTokensContract,
    configChain,
    originMultiSigContract,
    originAllowTokensAddress,
    cowAddress,
    originChainWeb3,
    originAnotherTokenContract,
    originUserAddress,
    amount,
    originTransactionSender,
    originAnotherTokenAddress,
    originUserPrivateKey,
    destinationTokenContract,
    destinationLoggerName,
    destinationBridgeContract,
    destinationChainId,
    originChainId,
    destinationChainWeb3,
  });

  // Cross AnotherToken (type id 0) Small Amount < toWei('0.01')
  const userSmallAmount = originChainWeb3.utils.toWei("0.0056");
  const userMediumAmount = originChainWeb3.utils.toWei("0.019"); // < toWei('0.1')
  const userLargeAmount = originChainWeb3.utils.toWei("1.32");
  const userAppoveTotalAmount = originChainWeb3.utils.toWei("10");

  logger.debug(
    "Send small amount, medium amount and large amount transactions"
  );
  const methodCallApprove = originAnotherTokenContract.methods.approve(
    originBridgeAddress,
    userAppoveTotalAmount
  );
  await methodCallApprove.call({ from: originUserAddress });
  await originTransactionSender.sendTransaction(
    originAnotherTokenAddress,
    methodCallApprove.encodeABI(),
    0,
    originUserPrivateKey,
    true
  );

  logger.debug("tranferCheckAmounts callAllReceiveTokens init");
  // Cross AnotherToken (type id 0) Small Amount < toWei('0.01')
  const { smallAmountReceipt, mediumAmountReceipt, largeAmountReceipt } =
    await callAllReceiveTokens({
      userSmallAmount,
      userMediumAmount,
      userLargeAmount,
      destinationChainId,
      originChainId,
      originBridgeContract,
      originAnotherTokenAddress,
      originUserAddress,
      originBridgeAddress,
      originTransactionSender,
      originUserPrivateKey,
    });
  logger.debug("tranferCheckAmounts callAllReceiveTokens finish");

  logger.debug("Mine small amount confirmations blocks");
  const delta_1 = parseInt(confirmations.smallAmount);
  await utils.evm_mine(delta_1, originChainWeb3);

  await runFederators(originFederators);
  logger.debug("Claim small amounts");
  const methodCallClaim = destinationBridgeContract.methods.claim({
    to: originUserAddress,
    amount: userSmallAmount,
    blockHash: smallAmountReceipt.blockHash,
    transactionHash: smallAmountReceipt.transactionHash,
    logIndex: smallAmountReceipt.logs[4].logIndex,
    originChainId: originChainId,
  });
  await methodCallClaim.call({ from: originUserAddress });
  await destinationTransactionSender.sendTransaction(
    destinationBridgeAddress,
    methodCallClaim.encodeABI(),
    0,
    originUserPrivateKey,
    true
  );
  logger.debug("Small amount claim completed");

  // check small amount txn went through
  let balance = await destinationSideTokenContract.methods
    .balanceOf(originUserAddress)
    .call();
  logger.info(
    `DESTINATION ${destinationLoggerName} token balance after ${delta_1} confirmations`,
    balance
  );

  const expectedBalanceUser =
    BigInt(destinationInitialUserBalance) + BigInt(userSmallAmount);
  if (expectedBalanceUser !== BigInt(balance)) {
    logger.error(
      `userSmallAmount. Wrong AnotherToken ${destinationLoggerName} User balance. Expected ${expectedBalanceUser} but got ${balance}`
    );
    process.exit(1);
  }

  logger.debug("Mine medium amount confirmations blocks");
  const delta_2 = parseInt(confirmations.mediumAmount) - delta_1;
  await utils.evm_mine(delta_2, originChainWeb3);

  await runFederators(originFederators);
  logger.debug("Claim medium amounts");
  const callerClaim = destinationBridgeContract.methods.claim({
    to: originUserAddress,
    amount: userMediumAmount,
    blockHash: mediumAmountReceipt.blockHash,
    transactionHash: mediumAmountReceipt.transactionHash,
    logIndex: mediumAmountReceipt.logs[4].logIndex,
    originChainId: originChainId,
  });
  await callerClaim.call({ from: originUserAddress });
  await destinationTransactionSender.sendTransaction(
    destinationBridgeAddress,
    callerClaim.encodeABI(),
    0,
    originUserPrivateKey,
    true
  );
  logger.debug("Medium amount claim completed");

  // check medium amount txn went through
  balance = await destinationSideTokenContract.methods
    .balanceOf(originUserAddress)
    .call();
  logger.info(
    `DESTINATION ${destinationLoggerName} token balance after ${
      delta_1 + delta_2
    } confirmations`,
    balance
  );

  const expectedBalanceUsers =
    BigInt(destinationInitialUserBalance) +
    BigInt(userMediumAmount) +
    BigInt(userSmallAmount);
  if (expectedBalanceUsers !== BigInt(balance)) {
    logger.error(
      `userMediumAmount + userSmallAmount. Wrong AnotherToken ${destinationLoggerName} User balance. Expected ${expectedBalanceUsers} but got ${balance}`
    );
    process.exit(1);
  }

  logger.debug("Mine large amount confirmations blocks");
  const delta_3 = parseInt(confirmations.largeAmount) - delta_2;
  await utils.evm_mine(delta_3, originChainWeb3);

  await runFederators(originFederators);
  const numberOfConfirmations = delta_1 + delta_2 + delta_3;
  await claimLargeAmounts({
    destinationBridgeContract,
    destinationChainId,
    originChainId,
    userAddress: originUserAddress,
    userLargeAmount,
    userMediumAmount,
    userSmallAmount,
    largeAmountReceipt,
    destinationTransactionSender,
    destinationBridgeAddress,
    userPrivateKey: originUserPrivateKey,
    destinationSideTokenContract,
    destinationLoggerName,
    numberOfConfirmations,
    destinationInitialUserBalance,
    anotherTokenContract: originAnotherTokenContract,
  });

  return { confirmations };
}

async function claimLargeAmounts({
  destinationBridgeContract,
  destinationChainId,
  originChainId,
  userAddress,
  userLargeAmount,
  userMediumAmount,
  userSmallAmount,
  largeAmountReceipt,
  destinationTransactionSender,
  destinationBridgeAddress,
  userPrivateKey,
  destinationSideTokenContract,
  destinationLoggerName,
  numberOfConfirmations,
  destinationInitialUserBalance,
  anotherTokenContract,
}) {
  logger.debug("Claim large amounts");
  const destinationCallerClaim = destinationBridgeContract.methods.claim({
    to: userAddress,
    amount: userLargeAmount,
    blockHash: largeAmountReceipt.blockHash,
    transactionHash: largeAmountReceipt.transactionHash,
    logIndex: largeAmountReceipt.logs[4].logIndex,
    originChainId: originChainId,
  });
  await destinationCallerClaim.call({ from: userAddress });
  await destinationTransactionSender.sendTransaction(
    destinationBridgeAddress,
    destinationCallerClaim.encodeABI(),
    0,
    userPrivateKey,
    true
  );
  logger.debug("Large amount claim completed");

  // check large amount txn went through
  const destinationBalance = await destinationSideTokenContract.methods
    .balanceOf(userAddress)
    .call();
  logger.info(
    `DESTINATION ${destinationLoggerName} token balance after ${numberOfConfirmations} confirmations`,
    destinationBalance
  );

  const expectedBalanceAll =
    BigInt(destinationInitialUserBalance) +
    BigInt(userLargeAmount) +
    BigInt(userMediumAmount) +
    BigInt(userSmallAmount);
  if (expectedBalanceAll !== BigInt(destinationBalance)) {
    logger.error(
      `Wrong AnotherToken ${destinationLoggerName} User balance. Expected ${expectedBalanceAll} but got ${destinationBalance}`
    );
    process.exit(1);
  }

  logger.debug(
    "ORIGIN user balance after crossing:",
    await anotherTokenContract.methods.balanceOf(userAddress).call()
  );
}

async function transferCheckErc777ReceiveTokensOtherSide({
  destinationBridgeContract,
  originUserAddress,
  amount,
  originReceiptSend,
  destinationTransactionSender,
  destinationBridgeAddress,
  originUserPrivateKey,
  destinationChainWeb3,
  destinationAnotherTokenAddress,
  destinationLoggerName,
  originChainWeb3,
  originWaitBlocks,
  destinationFederators,
  originBridgeContract,
  originChainId,
  destinationChainId,
  originBridgeAddress,
  originTokenContract,
  tokenContract,
}) {
  logger.info(
    "------------- CONTRACT ERC777 TEST RECEIVE THE TOKENS ON THE OTHER SIDE -----------------"
  );

  await claimTokensFromDestinationBridge({
    destinationBridgeContract,
    originUserAddress,
    amount,
    originReceiptSendTransaction: originReceiptSend,
    destinationTransactionSender,
    destinationBridgeAddress,
    originUserPrivateKey,
    originChainId,
  });

  const destTokenContract = new destinationChainWeb3.eth.Contract(
    abiSideToken,
    destinationAnotherTokenAddress
  );
  logger.debug("Check balance on the other side");
  await checkAddressBalance(
    destTokenContract,
    originUserAddress,
    destinationLoggerName
  );

  const crossUsrBalance = await originChainWeb3.eth.getBalance(
    originUserAddress
  );
  logger.debug("One way cross user balance", crossUsrBalance);

  logger.info(
    "------------- CONTRACT ERC777 TEST TRANSFER BACK THE TOKENS -----------------"
  );
  const senderBalanceBeforeErc777 = await destTokenContract.methods
    .balanceOf(originUserAddress)
    .call();

  const methodSendCall = destTokenContract.methods.send(
    destinationBridgeAddress,
    amount,
    originChainWeb3.eth.abi.encodeParameters(["uint256"], [originChainId])
  );
  methodSendCall.call({ from: originUserAddress });
  const receiptSendTx = await destinationTransactionSender.sendTransaction(
    destinationAnotherTokenAddress,
    methodSendCall.encodeABI(),
    0,
    originUserPrivateKey,
    true
  );

  logger.debug(`Wait for ${originWaitBlocks} blocks`);
  await utils.waitBlocks(destinationChainWeb3, originWaitBlocks);

  logger.warn(
    `------------- It will start the runFederators of the destinationFederators -------------`,
    destinationFederators
  );
  await runFederators(destinationFederators);
  await checkTxDataHash(originBridgeContract, receiptSendTx);

  logger.info(
    "------------- CONTRACT ERC777 TEST RECEIVE THE TOKENS ON THE STARTING SIDE -----------------"
  );
  const methodCallClaim = originBridgeContract.methods.claim({
    to: originUserAddress,
    amount: amount,
    blockHash: receiptSendTx.blockHash,
    transactionHash: receiptSendTx.transactionHash,
    logIndex: receiptSendTx.logs[5].logIndex,
    originChainId: destinationChainId,
  });
  await methodCallClaim.call({ from: originUserAddress });
  await destinationTransactionSender.sendTransaction(
    originBridgeAddress,
    methodCallClaim.encodeABI(),
    0,
    originUserPrivateKey,
    true
  );
  logger.debug("Destination Bridge claim completed");
  logger.debug("Getting final balances");

  const { senderBalance: senderBalanceAfterErc777 } = await getUsersBalances(
    originTokenContract,
    destTokenContract,
    originBridgeAddress,
    originUserAddress
  );

  if (senderBalanceBeforeErc777 === BigInt(senderBalanceAfterErc777)) {
    logger.error(
      `Wrong Sender balance. Expected Sender balance to change but got ${senderBalanceAfterErc777}`
    );
    process.exit(1);
  }

  const crossBackCompletedBalance = await originChainWeb3.eth.getBalance(
    originUserAddress
  );
  logger.debug("Final user balance", crossBackCompletedBalance);
}

async function transferCheckStartErc777({
  originChainWeb3,
  userAddress,
  amount,
  originTransactionSender,
  userPrivateKey,
  configChain,
  originAllowTokensContract,
  federatorKeys,
  destinationBridgeContract,
  destinationChainId,
  originChainId,
  destinationMultiSigContract,
  originMultiSigContract,
  destinationTransactionSender,
  destinationLoggerName,
  originBridgeAddress,
  waitBlocks,
  originFederators,
}) {
  logger.info(
    "------------- START CONTRACT ERC777 TEST TOKEN SEND TEST -----------------"
  );
  const originAnotherToken = new originChainWeb3.eth.Contract(abiSideToken);
  const knownAccount = (await originChainWeb3.eth.getAccounts())[0];

  logger.debug("Deploying another token contract");
  const originAnotherTokenContract = await originAnotherToken
    .deploy({
      data: destinationTokenBytecode,
      arguments: ["MAIN", "MAIN", userAddress, "1"],
    })
    .send({
      from: knownAccount,
      gas: 6700000,
      gasPrice: 20000000000,
    });
  logger.debug("Token deployed");
  logger.debug("Minting new token");
  const originAnotherTokenAddress = originAnotherTokenContract.options.address;
  const dataMintAbi = originAnotherTokenContract.methods
    .mint(userAddress, amount, "0x", "0x")
    .encodeABI();
  await originTransactionSender.sendTransaction(
    originAnotherTokenAddress,
    dataMintAbi,
    0,
    userPrivateKey,
    true
  );

  logger.debug("Adding new token to list of allowed on bridge");
  const originAllowTokensAddress = originAllowTokensContract.options.address;
  const originSetTokenEncodedAbi = originAllowTokensContract.methods
    .setToken(originAnotherTokenAddress, SIDE_TOKEN_TYPE_ID)
    .encodeABI();

  await sendFederatorTx(
    configChain.mainchain.multiSig,
    originMultiSigContract,
    originAllowTokensAddress,
    originSetTokenEncodedAbi,
    federatorKeys,
    originTransactionSender
  );

  const destinationAnotherTokenAddress = await getDestinationTokenAddress(
    destinationBridgeContract,
    originChainId,
    originAnotherTokenAddress,
    destinationMultiSigContract,
    destinationTransactionSender,
    configChain,
    destinationLoggerName
  );

  const methodCallSend = originAnotherTokenContract.methods.send(
    originBridgeAddress,
    amount,
    originChainWeb3.eth.abi.encodeParameters(
      ["address", "uint256"],
      [userAddress, destinationChainId]
    )
  );
  logger.warn("Calling bridge tokensReceived");
  const receipt = await methodCallSend.call({ from: userAddress });
  logger.debug("bridge tokensReceived receipt:", receipt);

  const originReceiptSend = await originTransactionSender.sendTransaction(
    originAnotherTokenAddress,
    methodCallSend.encodeABI(),
    0,
    userPrivateKey,
    true
  );
  logger.debug("Call to transferAndCall completed");

  logger.debug(`Wait for ${waitBlocks} blocks`);
  await utils.waitBlocks(originChainWeb3, waitBlocks);

  await runFederators(originFederators);

  return {
    originAnotherTokenAddress,
    originAnotherTokenContract,
    originAllowTokensAddress,
    destinationAnotherTokenAddress,
    originReceiptSend,
  };
}

async function transferCheckSendingTokens({
  originChainWeb3,
  originTransactionSender,
  configChain,
  destinationTransactionSender,
  originLoggerName,
  originAddress,
  originTokenContract,
  amount,
  cowAddress,
  originBridgeAddress,
  originAllowTokensContract,
  destinationChainWeb3,
  destinationChainId,
  originChainId,
}) {
  logger.info("------------- SENDING THE TOKENS -----------------");
  logger.debug("Getting address from pk");
  const originUserPrivateKey = originChainWeb3.eth.accounts.create().privateKey;
  const originUserAddress = await originTransactionSender.getAddress(
    originUserPrivateKey
  );
  await originTransactionSender.sendTransaction(
    originUserAddress,
    "",
    originChainWeb3.utils.toWei("1"),
    configChain.privateKey
  );
  await destinationTransactionSender.sendTransaction(
    originUserAddress,
    "",
    originChainWeb3.utils.toWei("1"),
    configChain.privateKey,
    true
  );
  logger.info(
    `${originLoggerName} token address ${originAddress} - User Address: ${originUserAddress}`
  );

  const originInitialUserBalance = await originChainWeb3.eth.getBalance(
    originUserAddress
  );
  logger.debug("Initial user balance ", originInitialUserBalance);
  await originTokenContract.methods
    .transfer(originUserAddress, amount)
    .send({ from: cowAddress });
  const initialTokenBalance = await originTokenContract.methods
    .balanceOf(originUserAddress)
    .call();
  logger.debug("Initial token balance ", initialTokenBalance);

  logger.debug("Approving token transfer");
  await originTokenContract.methods
    .transfer(originUserAddress, amount)
    .call({ from: originUserAddress });
  const methodTransferData = originTokenContract.methods
    .transfer(originUserAddress, amount)
    .encodeABI();
  await originTransactionSender.sendTransaction(
    originAddress,
    methodTransferData,
    0,
    configChain.privateKey,
    true
  );
  await originTokenContract.methods
    .approve(originBridgeAddress, amount)
    .call({ from: originUserAddress });

  const methodApproveData = originTokenContract.methods
    .approve(originBridgeAddress, amount)
    .encodeABI();
  await originTransactionSender.sendTransaction(
    originAddress,
    methodApproveData,
    0,
    originUserPrivateKey,
    true
  );
  logger.debug("Token transfer approved");

  logger.debug("Bridge receiveTokens (transferFrom)");
  const originBridgeContract = new originChainWeb3.eth.Contract(
    abiBridge,
    originBridgeAddress
  );
  logger.debug("Bridge addr", originBridgeAddress);
  logger.debug("allowTokens addr", originAllowTokensContract.options.address);
  logger.debug(
    "Bridge AllowTokensAddr",
    await originBridgeContract.methods.allowTokens().call()
  );
  logger.debug(
    "allowTokens primary",
    await originAllowTokensContract.methods.primary().call()
  );
  logger.debug(
    "allowTokens owner",
    await originAllowTokensContract.methods.owner().call()
  );
  logger.debug("accounts:", await originChainWeb3.eth.getAccounts());
  const originMethodCallReceiveTokensTo =
    originBridgeContract.methods.receiveTokensTo(
      destinationChainId,
      originAddress,
      originUserAddress,
      amount
    );
  await originMethodCallReceiveTokensTo.call({ from: originUserAddress });
  const originReceiptSendTransaction =
    await originTransactionSender.sendTransaction(
      originBridgeAddress,
      originMethodCallReceiveTokensTo.encodeABI(),
      0,
      originUserPrivateKey,
      true
    );
  logger.debug("Bridge receivedTokens completed");

  const originWaitBlocks = configChain.confirmations || 0;
  logger.debug(`Wait for ${originWaitBlocks} blocks`);
  await utils.waitBlocks(originChainWeb3, originWaitBlocks);

  logger.debug("Starting federator processes");

  // Start origin federators with delay between them
  logger.debug("Fund federator wallets");
  const federatorPrivateKeys =
    mainKeys && mainKeys.length ? mainKeys : [configChain.privateKey];
  await fundFederators(
    configChain.sidechain.host,
    federatorPrivateKeys,
    configChain.sidechain.privateKey,
    destinationChainWeb3.utils.toWei("1")
  );

  return {
    originReceiptSendTransaction,
    originUserAddress,
    originUserPrivateKey,
    federatorPrivateKeys,
    originBridgeContract,
    originInitialUserBalance,
    originWaitBlocks,
  };
}

async function transferChecks({
  originChainWeb3,
  originTransactionSender,
  configChain,
  destinationTransactionSender,
  originLoggerName,
  originAddress: originTokenAddress,
  originTokenContract,
  amount,
  cowAddress,
  originBridgeAddress,
  originAllowTokensContract,
  destinationChainWeb3,
  originFederators,
  destinationTokenAddress,
  destinationBridgeContract,
  destinationChainId,
  originChainId,
  destinationBridgeAddress,
  destinationLoggerName,
  originMultiSigContract,
  destinationMultiSigContract,
  destinationAllowTokensAddress,
  destinationFederators,
}) {
  const {
    originReceiptSendTransaction,
    originUserAddress,
    originUserPrivateKey,
    federatorPrivateKeys,
    originBridgeContract,
    originInitialUserBalance,
    originWaitBlocks,
  } = await transferCheckSendingTokens({
    originChainWeb3,
    originTransactionSender,
    configChain,
    destinationTransactionSender,
    originLoggerName,
    originAddress: originTokenAddress,
    originTokenContract,
    amount,
    cowAddress,
    originBridgeAddress,
    originAllowTokensContract,
    destinationChainWeb3,
    destinationChainId,
    originChainId,
  });
  await runFederators(originFederators);
  logger.info(
    "------------- RECEIVE THE TOKENS ON THE OTHER SIDE -----------------"
  );

  const destinationTokenContract = new destinationChainWeb3.eth.Contract(
    abiSideToken,
    destinationTokenAddress
  );

  logger.info("transferReceiveTokensOtherSide init");
  await transferReceiveTokensOtherSide({
    destinationBridgeContract,
    destinationChainId,
    originChainId,
    originReceiptSendTransaction,
    originUserAddress,
    amount,
    destinationTransactionSender,
    destinationBridgeAddress,
    originUserPrivateKey,
    destinationLoggerName,
    destinationTokenContract,
    originChainWeb3,
  });
  logger.info("transferReceiveTokensOtherSide finish");

  logger.info("------------- TRANSFER BACK THE TOKENS -----------------");
  logger.debug("Getting initial balances before transfer");
  const {
    bridgeBalance: bridgeBalanceBefore,
    receiverBalance: receiverBalanceBefore,
    senderBalance: senderBalanceBefore,
  } = await getUsersBalances(
    originTokenContract,
    destinationTokenContract,
    originBridgeAddress,
    originUserAddress
  );

  const destinationReceiptReceiveTokensTo = await transferBackTokens({
    destinationTokenContract,
    originUserAddress,
    destinationTransactionSender,
    configChain,
    destinationBridgeAddress,
    amount,
    originTokenAddress,
    destinationTokenAddress,
    originUserPrivateKey,
    originMultiSigContract,
    destinationMultiSigContract,
    destinationAllowTokensAddress,
    federatorPrivateKeys,
    destinationBridgeContract,
    destinationChainId,
    originChainId,
    originChainWeb3,
    destinationFederators,
  });

  logger.info(
    "------------- RECEIVE THE TOKENS ON THE STARTING SIDE -----------------"
  );
  logger.debug("Check balance on the starting side");
  const methodCallClaim = originBridgeContract.methods.claim({
    to: originUserAddress,
    amount: amount,
    blockHash: destinationReceiptReceiveTokensTo.blockHash,
    transactionHash: destinationReceiptReceiveTokensTo.transactionHash,
    logIndex: destinationReceiptReceiveTokensTo.logs[6].logIndex,
    originChainId: destinationChainId,
  });
  await methodCallClaim.call({ from: originUserAddress });
  await originTransactionSender.sendTransaction(
    originBridgeAddress,
    methodCallClaim.encodeABI(),
    0,
    originUserPrivateKey,
    true
  );
  logger.debug("Bridge receivedTokens completed");

  logger.debug("Getting final balances");
  const {
    bridgeBalance: bridgeBalanceAfter,
    receiverBalance: receiverBalanceAfter,
    senderBalance: senderBalanceAfter,
  } = await getUsersBalances(
    originTokenContract,
    destinationTokenContract,
    originBridgeAddress,
    originUserAddress
  );

  const expectedBalanceBridge = BigInt(bridgeBalanceBefore) - BigInt(amount);
  checkBalance(bridgeBalanceAfter, expectedBalanceBridge);
  const expBalanceReceiver = BigInt(receiverBalanceBefore) + BigInt(amount);
  checkBalance(receiverBalanceAfter, expBalanceReceiver);
  const expectedBalanceSender = BigInt(senderBalanceBefore) - BigInt(amount);
  checkBalance(senderBalanceAfter, expectedBalanceSender);

  const crossBackCompletedBalance = await originChainWeb3.eth.getBalance(
    originUserAddress
  );
  logger.debug("Final user balance", crossBackCompletedBalance);
  logger.debug(
    "Cost: ",
    BigInt(originInitialUserBalance) - BigInt(crossBackCompletedBalance)
  );

  const {
    originAnotherTokenAddress,
    originAnotherTokenContract,
    originAllowTokensAddress,
    destinationAnotherTokenAddress,
    originReceiptSend,
  } = await transferCheckStartErc777({
    originChainWeb3,
    userAddress: originUserAddress,
    amount,
    originTransactionSender,
    userPrivateKey: originUserPrivateKey,
    configChain,
    originAllowTokensContract,
    federatorKeys: federatorPrivateKeys,
    destinationBridgeContract,
    destinationChainId,
    originChainId,
    destinationMultiSigContract,
    originMultiSigContract,
    destinationTransactionSender,
    destinationLoggerName,
    originBridgeAddress,
    waitBlocks: originWaitBlocks,
    originFederators,
  });

  await transferCheckErc777ReceiveTokensOtherSide({
    destinationBridgeContract,
    originUserAddress,
    amount,
    originReceiptSend,
    destinationTransactionSender,
    destinationBridgeAddress,
    originUserPrivateKey,
    destinationChainWeb3,
    destinationAnotherTokenAddress,
    destinationLoggerName,
    originChainWeb3,
    originWaitBlocks,
    destinationFederators,
    originBridgeContract,
    originChainId,
    destinationChainId,
    originBridgeAddress,
    originTokenContract,
    tokenContract: originTokenContract,
  });

  return {
    originAllowTokensAddress,
    destinationTokenContract,
    originUserAddress,
    originUserPrivateKey,
    originAnotherTokenContract,
    originAnotherTokenAddress,
    originBridgeContract,
  };
}

async function transfer(
  originFederators,
  destinationFederators,
  configChain,
  originLoggerName,
  destinationLoggerName
) {
  try {
    const originChainWeb3 = new Web3(configChain.mainchain.host);
    const originChainId = await originChainWeb3.eth.net.getId();
    const destinationChainWeb3 = new Web3(configChain.sidechain.host);
    const destinationChainId = await destinationChainWeb3.eth.net.getId();
    // Increase time in one day to reset all the Daily limits from AllowTokens
    await utils.increaseTimestamp(originChainWeb3, ONE_DAY_IN_SECONDS + 1);
    await utils.increaseTimestamp(destinationChainWeb3, ONE_DAY_IN_SECONDS + 1);

    const originTokenContract = new originChainWeb3.eth.Contract(
      abiMainToken,
      configChain.mainchain.testToken
    );
    const originTransactionSender = new TransactionSender(
      originChainWeb3,
      logger,
      configChain
    );
    const destinationTransactionSender = new TransactionSender(
      destinationChainWeb3,
      logger,
      configChain
    );
    const originBridgeAddress = configChain.mainchain.bridge;
    const originAmount10Wei = originChainWeb3.utils.toWei("10");
    const originAddress = originTokenContract.options.address;
    const cowAddress = (await originChainWeb3.eth.getAccounts())[0];
    const originAllowTokensContract = new originChainWeb3.eth.Contract(
      abiAllowTokens,
      configChain.mainchain.allowTokens
    );
    const originMultiSigContract = new originChainWeb3.eth.Contract(
      abiMultiSig,
      configChain.mainchain.multiSig
    );
    const destinationMultiSigContract = new destinationChainWeb3.eth.Contract(
      abiMultiSig,
      configChain.sidechain.multiSig
    );
    const destinationAllowTokensAddress = configChain.sidechain.allowTokens;
    const destinationBridgeAddress = configChain.sidechain.bridge;
    logger.debug(
      `${destinationLoggerName} bridge address`,
      destinationBridgeAddress
    );
    const destinationBridgeContract = new destinationChainWeb3.eth.Contract(
      abiBridge,
      destinationBridgeAddress
    );

    logger.debug("Get the destination token address");
    const destinationTokenAddress = await getDestinationTokenAddress(
      destinationBridgeContract,
      originChainId,
      originAddress,
      destinationMultiSigContract,
      destinationTransactionSender,
      configChain,
      destinationLoggerName
    );

    const {
      originAllowTokensAddress,
      destinationTokenContract,
      originUserAddress,
      originUserPrivateKey,
      originAnotherTokenContract,
      originAnotherTokenAddress,
      originBridgeContract,
    } = await transferChecks({
      originChainWeb3,
      originTransactionSender,
      configChain,
      destinationTransactionSender,
      originLoggerName,
      originAddress,
      originTokenContract,
      amount: originAmount10Wei,
      cowAddress,
      originBridgeAddress,
      originAllowTokensContract,
      destinationChainWeb3,
      originFederators,
      destinationTokenAddress,
      destinationBridgeContract,
      destinationChainId,
      originChainId,
      destinationBridgeAddress,
      destinationLoggerName,
      originMultiSigContract,
      destinationMultiSigContract,
      destinationAllowTokensAddress,
      destinationFederators,
    });

    logger.debug("transfer tranferCheckAmounts init");
    const { confirmations } = await tranferCheckAmounts({
      originAllowTokensContract,
      configChain,
      originMultiSigContract,
      originAllowTokensAddress,
      cowAddress,
      originChainWeb3,
      originAnotherTokenContract,
      originUserAddress,
      amount: originAmount10Wei,
      originTransactionSender,
      originAnotherTokenAddress,
      originUserPrivateKey,
      destinationTokenContract,
      destinationLoggerName,
      destinationBridgeContract,
      destinationChainId,
      destinationChainWeb3,
      originBridgeAddress,
      originBridgeContract,
      originChainId,
      originFederators,
      destinationTransactionSender,
      destinationBridgeAddress,
    });
    logger.debug("transfer tranferCheckAmounts finish");

    await resetConfirmationsForFutureRuns(
      originAllowTokensContract,
      configChain,
      originMultiSigContract,
      originAllowTokensAddress,
      cowAddress,
      originChainWeb3,
      confirmations
    );
  } catch (err) {
    logger.error("Unhandled error:", err.stack);
    process.exit(1);
  }
}

async function getDestinationTokenAddress(
  destinationBridgeContract,
  originChainId,
  originAddressMainToken,
  destinationMultiSigContract,
  destinationTransactionSender,
  chainConfig,
  destinationLoggerName
) {
  let destinationTokenAddress = await destinationBridgeContract.methods
    .sideTokenByOriginalToken(originChainId, originAddressMainToken)
    .call();

  logger.warn(
    `destinationTokenAddress: ${destinationTokenAddress}\nchainIdMain: ${originChainId}\noriginAddressMain: ${originAddressMainToken}`
  );
  if (destinationTokenAddress === utils.zeroAddress) {
    logger.info("Side Token does not exist yet, creating it");
    const data = destinationBridgeContract.methods
      .createSideToken(
        SIDE_TOKEN_TYPE_ID,
        originAddressMainToken,
        SIDE_TOKEN_DECIMALS,
        SIDE_TOKEN_SYMBOL,
        SIDE_TOKEN_NAME,
        originChainId
      )
      .encodeABI();
    const destinationMultiSigData = destinationMultiSigContract.methods
      .submitTransaction(destinationBridgeContract.options.address, 0, data)
      .encodeABI();
    await destinationTransactionSender.sendTransaction(
      chainConfig.sidechain.multiSig,
      destinationMultiSigData,
      0,
      "",
      true
    );
    destinationTokenAddress = await destinationBridgeContract.methods
      .sideTokenByOriginalToken(originChainId, originAddressMainToken)
      .call();
    if (destinationTokenAddress === utils.zeroAddress) {
      logger.error("Failed to create side token");
      process.exit(1);
    }
  }
  logger.info(
    `${destinationLoggerName} token address`,
    destinationTokenAddress
  );
  return destinationTokenAddress;
}

async function claimTokensFromDestinationBridge({
  destinationBridgeContract,
  originChainId,
  originUserAddress,
  amount,
  originReceiptSendTransaction,
  destinationTransactionSender,
  destinationBridgeAddress,
  originUserPrivateKey,
}) {
  console.log(
    "claimTokensFromDestinationBridge originUserAddress",
    originUserAddress
  );
  console.log("claimTokensFromDestinationBridge amount", amount);
  console.log(
    "claimTokensFromDestinationBridge blockHash",
    originReceiptSendTransaction.blockHash
  );
  console.log(
    "claimTokensFromDestinationBridge transactionHash",
    originReceiptSendTransaction.transactionHash
  );
  console.log(
    "claimTokensFromDestinationBridge logIndex",
    originReceiptSendTransaction.logs[3].logIndex
  );
  console.log("claimTokensFromDestinationBridge originChainId", originChainId);
  const destinationMethodCallClaim = destinationBridgeContract.methods.claim({
    to: originUserAddress,
    amount: amount,
    blockHash: originReceiptSendTransaction.blockHash,
    transactionHash: originReceiptSendTransaction.transactionHash,
    logIndex: originReceiptSendTransaction.logs[3].logIndex,
    originChainId: originChainId,
  });
  await destinationMethodCallClaim.call({ from: originUserAddress });
  await destinationTransactionSender.sendTransaction(
    destinationBridgeAddress,
    destinationMethodCallClaim.encodeABI(),
    0,
    originUserPrivateKey,
    true
  );
  logger.debug("Destination Bridge claim completed");
  return destinationMethodCallClaim;
}

async function resetConfirmationsForFutureRuns(
  originAllowTokensContract,
  chainConfig,
  originMultiSigContract,
  allowTokensAddress,
  cowAddress,
  originChainWeb3,
  confirmations
) {
  await originAllowTokensContract.methods
    .setConfirmations("0", "0", "0")
    .call({ from: chainConfig.mainchain.multiSig });
  const data = originAllowTokensContract.methods
    .setConfirmations("0", "0", "0")
    .encodeABI();

  const methodCall = originMultiSigContract.methods.submitTransaction(
    allowTokensAddress,
    0,
    data
  );
  await methodCall.call({ from: cowAddress });
  await methodCall.send({ from: cowAddress, gas: 500000 });
  await utils.evm_mine(1, originChainWeb3);
  const allowTokensConfirmations = await originAllowTokensContract.methods
    .getConfirmations()
    .call();
  logger.debug(
    `reset confirmations: ${allowTokensConfirmations.smallAmount}, ${allowTokensConfirmations.mediumAmount}, ${allowTokensConfirmations.largeAmount}`
  );
  return { data, methodCall, allowTokensConfirmations };
}
