const LibUtilsHarness = artifacts.require('./LibUtilsHarness');
const MainToken = artifacts.require('./MainToken');
const AlternativeERC20Detailed = artifacts.require('./AlternativeERC20Detailed');
const SideToken = artifacts.require('./SideToken');

const BN = web3.utils.BN;
const utils = require('./utils');

contract('LibUtils', async function (accounts) {
    const owner = accounts[0];

    before(async function () {
        await utils.saveState();
    });

    after(async function () {
        await utils.revertState();
    });

    beforeEach(async function () {
        this.utilsLib = await LibUtilsHarness.new();
    });

    describe('decimals conversion', async function () {
        it('decimals to granularity', async function () {
            let resultGranularity = await this.utilsLib.decimalsToGranularity(18);
            assert.equal(resultGranularity.toString(), '1');
            resultGranularity = await this.utilsLib.decimalsToGranularity(9);
            assert.equal(resultGranularity.toString(), '1000000000');
            resultGranularity = await this.utilsLib.decimalsToGranularity(6);
            assert.equal(resultGranularity.toString(), '1000000000000');
            resultGranularity = await this.utilsLib.decimalsToGranularity(0);
            assert.equal(resultGranularity.toString(), new BN('1000000000000000000').toString());
        });

        it('decimals to granularity should fail over 18 decimals', async function () {
            await utils.expectThrow(this.utilsLib.decimalsToGranularity(19));
        });

    });
    describe('getDecimals', async function () {
        it('from uint8', async function () {
            let token = await MainToken.new("MAIN", "MAIN", 18, web3.utils.toWei('10000'), { from: owner });
            let resultDecimals = await this.utilsLib.getDecimals(token.address);
            assert.equal(resultDecimals, 18);
            token = await MainToken.new("MAIN", "MAIN", 0, web3.utils.toWei('10000'), { from: owner });
            resultDecimals = await this.utilsLib.getDecimals(token.address);
            assert.equal(resultDecimals, 0);
        });

        it('Throw if is not a contract', async function () {
            await utils.expectThrow(this.utilsLib.getDecimals(owner));
        });

        it('Throw if does not have decimals()', async function () {
            await utils.expectThrow(this.utilsLib.getDecimals(this.utilsLib.address));
        });

        it('from  uint256', async function () {
            let token = await AlternativeERC20Detailed.new("ALT", utils.ascii_to_hexa("ALT"), 18, web3.utils.toWei('10000'), { from: owner });
            let resultGranularity = await this.utilsLib.getDecimals(token.address);
            assert.equal(resultGranularity, 18);
            token = await AlternativeERC20Detailed.new("ALT", utils.ascii_to_hexa("ALT"), 0, web3.utils.toWei('10000'), { from: owner });
            resultGranularity = await this.utilsLib.getDecimals(token.address);
            assert.equal(resultGranularity, 0);
        });
    });


    describe('getGranularity', async function () {
        it('from ERC777', async function () {
            let granularity = '1';
            let token = await SideToken.new("SIDE", "SIDE", owner, granularity);
            let resultGranularity = await this.utilsLib.getGranularity(token.address);
            assert.equal(resultGranularity.toString(), granularity);

            granularity = '1000000000000000000';
            token = await SideToken.new("SIDE", "SIDE", owner, granularity);
            resultGranularity = await this.utilsLib.getGranularity(token.address);
            assert.equal(resultGranularity.toString(), granularity);
        });
    });

    describe('bytesToAddress', async function () {
        it('should convert bytes to address', async function () {
            const bytes = accounts[1];
            let result = await this.utilsLib.bytesToAddress(bytes);

            assert.equal(result, accounts[1]);
        });
        it('should convert only firs 20 bytes to address', async function () {
            const bytes = accounts[1] + owner.substring(2);
            let result = await this.utilsLib.bytesToAddress(bytes);

            assert.equal(result, accounts[1]);
        });
    });

});
