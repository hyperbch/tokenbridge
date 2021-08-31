const fs = require('fs');
const hardhatConfig = require('../hardhat.config');
const toWei = web3.utils.toWei;

module.exports = async function ({getNamedAccounts, deployments, network}) { // HardhatRuntimeEnvironment
    const {deployer, multiSig} = await getNamedAccounts();
    const {log} = deployments;

    if (network.name === 'soliditycoverage' || network.name === 'hardhat') {
        return;
    }
    const BridgeProxy = await deployments.get('BridgeProxy');
    const FederationV2 = await deployments.get('FederationV2');
    const MultiSigWallet = await deployments.get('MultiSigWallet');
    const AllowTokensProxy = await deployments.get('AllowTokensProxy');

    const config = {
        bridge: BridgeProxy.address.toLowerCase(),
        federation: FederationV2.address.toLowerCase(),
        multiSig: multiSig ?? MultiSigWallet.address.toLowerCase(),
        allowTokens: AllowTokensProxy.address.toLowerCase()
    };

    if (!network.live) {
        const AllowTokens = await deployments.get('AllowTokens');
        const allowTokens = new web3.eth.Contract(AllowTokens.abi, AllowTokensProxy.address);
        const multiSigContract = new web3.eth.Contract(MultiSigWallet.abi, multiSig ?? MultiSigWallet.address);

        const MainToken = await deployments.get('MainToken');
        config.testToken = MainToken.address.toLowerCase();
        let data = allowTokens.methods.addTokenType(
            'MAIN',
            {
                max:toWei('10000'),
                min:toWei('1'),
                daily:toWei('100000'),
                mediumAmount:toWei('2'),
                largeAmount:toWei('3')
            }
        ).encodeABI();
        await multiSigContract.methods.submitTransaction(AllowTokensProxy.address, 0, data).send({ from: deployer });
        log(`MultiSig submitTransaction addTokenType in the AllowTokens`);

        const typeId = 0;
        data = allowTokens.methods.setToken(MainToken.address, typeId).encodeABI();
        await multiSigContract.methods.submitTransaction(AllowTokensProxy.address, 0, data).send({ from: deployer });
        log(`MultiSig submitTransaction setToken MainToken in the AllowTokens`);
        // Uncomment below lines to use multiple federators
        // await multiSigContract.confirmTransaction(0).send({ from: accounts[1] });
        // await multiSigContract.confirmTransaction(0).send({ from: accounts[2] });
    }
    const host = hardhatConfig.networks[network.name]?.url
    if (host) {
        config.host = host;
    } else {
        config.host = '';
    }
    config.fromBlock = await web3.eth.getBlockNumber();
    fs.writeFileSync(`../federator/config/${network.name}.json`, JSON.stringify(config, null, 4));

};
module.exports.id = 'create_config_file'; // id required to prevent reexecution
module.exports.tags = ['CreateConfigFile', 'new'];
module.exports.dependencies = ['BridgeProxy', 'FederationV2', 'MultiSigWallet', 'AllowTokens'];
