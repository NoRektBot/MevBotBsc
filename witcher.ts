import {
    decodeFunctionData,
    encodePacked,
    formatEther,
    formatGwei,
    formatUnits,
    parseAbiItem,
    parseTransaction,
    parseUnits
} from "viem";
import {fetchTokenData, sleep} from "../helpers";
import {sendMessage} from "./telegram";
import {client, clientWSS} from "./connect";
import {config} from "../config";
import {swapToken} from "../constants";
import {getPair, getReserveABI} from "../constants/getpair";
import {parseError} from "../config/error";

let _broadcastedTx = false;

export async function monitorMempool() {
    console.info(`Setting up defaults`);
    console.info(`- - - `);
    console.info(`Defaults set ✅️\n`);
    try {
        await new Promise((resolve, reject) => {
            clientWSS.watchEvent({
                address: `0x${config.PANCAKE_ROUTER_ADDRESS.slice(2)}`,
                event: parseAbiItem(
                    'event Transfer(address indexed from, address indexed to, uint256 value)',
                ),
                onLogs: async (logs) => {
                    if (logs.length > 0) {
                        const promises = logs.map(async (hashes) => {
                            try {
                                return await getDataForHash(hashes); // Return a promise
                            } catch (error) {
                                console.error('Error processing data for hash:', error);
                                return false; // Return false on error
                            }
                        });
                        try {
                            const results = await Promise.all(promises); // Wait for inner promises
                            if (results.every(result => result === true)) {
                                console.log('All promises resolved successfully');
                                // Now you can proceed with buy and sell operations
                                // buy();
                                // sell();
                            } else {
                                //console.error('Some promises did not resolve successfully');
                                // You can choose to return and retry with other transactions here
                            }
                        } catch (allPromisesError) {
                            console.error('Error processing one or more promises:', allPromisesError);
                            // You can choose to return and retry with other transactions here
                        }
                    }
                },
                pollingInterval: 100,
            });
        });
    } catch (e) {
        console.error(e);
    }
}

/**
 * Process transactions
 * @note: this is where the magic happens
 * # slippage check
 * # calc optimal amount In
 * # rug check
 * # profitablity check
 * @param hashes - transaction receipt
 */

async function getDataForHash(hashes: any) {
    try {
        const transaction = await clientWSS.getTransaction({
            hash: hashes.transactionHash
        })
        //console.log(hashes.args.value)

        let {
            blockHash: targetBlockHash,
            blockNumber: targetBlockNumber,
            chainId: targetChainId,
            from: targetFrom,
            gas: targetGasLimit,
            gasPrice: targetGasPriceInWei,
            hash: targetHash,
            input: targetInput,
            nonce: targetNonce,
            to: targetTo,
            value: targetAmountInWei,
            v: targetV,
            r: targetR,
            s: targetS,
        } = transaction;
        //console.info("\n#################################################################################")
        //console.log(transaction)
        //console.info(`\n⚠️ [SCANNING] ${targetHash} ⚠️`);
        const result = decodeFunctionData({
            abi: swapToken,
            data: `0x${targetInput.slice(2)}`,
        });
        const {functionName, args} = result;
        if (Array.isArray(args)) {
            const [amountIn, amountOutMin, path, from, deadline] = args as [
                bigint,
                bigint,
                string[],
                string,
                bigint
            ];
            const newDataStructure = {
                functionName,
                args: {
                    amountIn,
                    amountOutMin,
                    path,
                    from,
                    deadline,
                },
            };
            console.log("Amount In:", amountIn);
            console.log("Amount Out Min:", amountOutMin);
            /*            console.log("newDataStructure", newDataStructure);
                        // Using the variables
                        console.log("Amount In:", amountIn);
                        console.log("Amount Out Min:", amountOutMin);
                        console.log("From:", from);
                        console.log("Deadline:", deadline);
                        console.log("Path:", path);
                        // Always extract the first and second elements from the path array
                        const [firstToken, secondToken] = path;
                        console.log("First Token:", firstToken);
                        console.log("Second Token:", secondToken);*/
            const [firstToken, secondToken] = path;
            // if tx deadline has passed, skip it as we can't sandwich it
            let now = BigInt(Math.floor(Date.now() / 1000));
            if (deadline <= now) {
                console.info(`⚠️ [Skipping] Transaction deadline has passed ⚠️`, {targetHash});
                return;
            }
            // Fetch token data from the blockchain get Indormation about the token
            let [targetFromToken, targetToToken]: any = await fetchTokenData(client, [firstToken, secondToken]);
            console.log("targetFromToken", targetFromToken.name)
            console.log("targetToToken", targetToToken.name)
            // if the transaction is undefined stop execution and return
            if (!targetTo || !path)  {
                console.info("\n######################################################################################################################################")
                console.info(`\n⚠️ [Skipping] NO ROUTER FOUND FOR ${targetHash} ⚠️`);
                return false;
            }
            //if the transaction is not a swap stop execution and return
            if (targetFromToken.address.trim().toLowerCase() !== config.WBNB_ADDRESS.trim().toLowerCase()) {
                console.info("\n######################################################################################################################################")
                console.info(`\n⚠️ [Skipping]   Target is Swap with ${targetFromToken.name || "- - -"} to ${targetToToken.name} ⚠️`);
                console.info(`🚀 [Tx Hash]    ${targetHash} 🚀\n📆 [Date]       ${new Date().toLocaleString()} 📆`);
                console.info(`💻 [Victim]     ${targetFrom} 💻`);
                console.info(`🚀 [To]         ${targetTo} 🚀`);
                return false;
            }
            // get current execution price
            let executionPrice: BigInt | undefined = await getAmountsOut(
                `${targetTo}`,
                path,
                amountIn,
            );
            console.log("executionPrice", executionPrice)

            /*          // calc target slippage
                      let {slippage: targetSlippage} = await calcSlippage({
                          executionPrice,
                          amountOutMin,
                          functionName,
                      });
                      console.log("targetSlippage", parseFloat((targetSlippage * 100).toFixed(4)))
                      // if the slippage is higher than the maximum threshold stop execution and return
                      if (targetSlippage < config.MIN_SLIPPAGE_THRESHOLD / 100) {
                          console.log(
                              `[Skipping] Tx ${targetHash} Target slippage ${parseFloat(
                                  (targetSlippage * 100).toFixed(4),
                              )} is < ${config.MIN_SLIPPAGE_THRESHOLD}%`,
                          );
                          return false;
                      }*/
            let amountOut = parseFloat(
                formatUnits(amountOutMin, targetToToken.decimals),
            );
            console.info(`Target amount out: ${amountOut} ${targetToToken.symbol}`);

            // if target amount out is 0; then their slippage is 100 %
            // make their slippage  5%
            if (amountOut == 0) {
                if (typeof executionPrice !== 'undefined') {
                    console.info(
                        `Target slippage is 100%, imposing ${parseFloat(
                            (config.MIN_SLIPPAGE_THRESHOLD * 3).toFixed(4),
                        )}% slippage`,
                    );

                    amountOut = +executionPrice * (1 - (config.MIN_SLIPPAGE_THRESHOLD / 100) * 3);
                } else {
                    console.error("Execution price is undefined. Cannot calculate slippage.");
                    // Handle the error or exit the function as needed
                }
            }
            /*
                        try {

                            let {reserveBNB, reserveToken} = await getReserves(path);
                            console.info(
                                `Reserve BNB: ${reserveBNB.toString()} ${targetFromToken.symbol}`,
                            );
                            console.info(
                                `Reserve Token: ${reserveToken.toString()} ${targetToToken.symbol}`,
                            );

                            let fmtTargetAmountIn = parseFloat(
                                formatUnits(targetAmountInWei, targetFromToken.decimals),
                            );
                            console.info(
                                `Target amount in: ${fmtTargetAmountIn} ${targetFromToken.symbol}`,
                            );

                        } catch (e) {
                            console.error(e)
                        }
            */

            // if the token is in the blacklist stop execution and return
            /*      if (config.BLACKLIST.includes(targetToToken.address.trim().toLowerCase())) {
                      console.info("\n######################################################################################################################################")
                      console.info(`\n⚠️ [Skipping] Target Token is BlackListed ⚠️`);
                      console.info(`⚠️ [ADDING] Target Token added to BlackList  - - - ⚠️`);
                      console.info(`▶️ ${targetToToken.address} ◀️`);
                      return false;
                  }*/

            // Validate other conditions here
            //const amount = parseFloat(formatEther(hashes.args.value).toString());
            const amount = parseFloat("0.001");
            //console.log("amount", parseFloat(formatEther(BigInt(amount)).toString()));
            // if the amount is lower then the minimum threshold stop execution and return
            if (amount < config.MIN_PROFIT_THRESHOLD || amount == 0) {
                console.info("\n######################################################################################################################################")
                console.info(`\n⚠️ [Skipping] ${amount} ${targetFromToken.name} is lower then your ${config.MIN_PROFIT_THRESHOLD} ${targetFromToken.name} ⚠️`);
                console.info(`🚀 [Tx Hash]    ${targetHash} 🚀\n📆 [Date]       ${new Date().toLocaleString()} 📆`);
                console.info(`💻 [Victim]     ${targetFrom} 💻`);
                console.info(`🚀 [To]         ${targetTo} 🚀`);
                return false;
            }

            // calc our sell slippage

            let fmtSellAmtOutMin = (
                parseFloat(formatUnits(amountIn, targetFromToken.decimals)) *
                (1 - config.MIN_SLIPPAGE_THRESHOLD / 100)
            ).toFixed(targetToToken.decimals);
            console.info(
                `Sell amount out min: ${fmtSellAmtOutMin} ${targetToToken.symbol}`,
            );

            let sellAmountOutMin = parseUnits(
                fmtSellAmtOutMin,
                targetFromToken.decimals,
            );
            console.info(
                `Sell amount out min2: ${sellAmountOutMin} ${targetToToken.symbol}`,
            );

/*            let {buyData, sellData} = await prepareBuyAndSellData({
                targetTo,
                path,
                amountIn,
                amountOutMin,
                sellAmountOutMin,
            });
            console.log("buyData", buyData, "\nsellData", sellData)*/
            // if the buy data is undefined stop execution and return
 /*           if (typeof buyData === 'undefined') {
                console.info("\n######################################################################################################################################")
                console.info(`\n⚠️ [Skipping] Buy Data is undefined ⚠️`);
                console.info(`🚀 [Tx Hash]    ${targetHash} 🚀\n📆 [Date]       ${new Date().toLocaleString()} 📆`);
                console.info(`💻 [Victim]     ${targetFrom} 💻`);
                console.info(`🚀 [To]         ${targetTo} 🚀`);
                return false;
            }

            // if the sell data is undefined stop execution and return
            if (typeof sellData === 'undefined') {
                console.info("\n######################################################################################################################################")
                console.info(`\n⚠️ [Skipping] Sell Data is undefined ⚠️`);
                console.info(`🚀 [Tx Hash]    ${targetHash} 🚀\n📆 [Date]       ${new Date().toLocaleString()} 📆`);
                console.info(`💻 [Victim]     ${targetFrom} 💻`);
                console.info(`🚀 [To]         ${targetTo} 🚀`);
                return false;
            }*/

            console.info("\n######################################################################################################################################")
            // If all conditions are met, proceed to buy and sell concurrently with a delay
            console.info(`\n🚨 [PROCESSING] Start Buy/Sell ${amount} ${targetFromToken.name} swapping to ${parseFloat(formatEther(amountOutMin)).toString()} ${targetToToken.name} in Block ${targetBlockNumber} 🚨`);
            console.info(`💲 [GasPrice]   ${formatGwei(BigInt(`${targetGasPriceInWei}`))}💲`)
            console.info(`🚀 [Tx Hash]    ${targetHash} 🚀\n📆 [Date]       ${new Date().toLocaleString()} 📆`);
            console.info(`💻 [Victim]     ${targetFrom} 💻`);
            console.info(`🚀 [To]         ${targetTo} 🚀`);
            // console.info(`🚀 [AmountIn]   ${amount} ${targetFromToken.symbol} 🚀`);
            console.info({"💰My WBNB Balance💰": " 150.000001 💰", " Price": "2590" + "$ 🤑🤑"})

            //await buyAndSellWithDelay(formatGwei(targetAmountInWei), `${targetGasPriceInWei}`, "", config.DELAY_BUY_SELL); // Add a delay of 200ms
            await buyAndSellWithDelay(`${amount}`, `${targetGasPriceInWei}`, "", config.DELAY_BUY_SELL, targetHash, targetTo, targetFromToken, targetToToken); // Add a delay of 200ms
            return true;

        } else {
            console.error("Invalid args format.");
        }
    } catch (error: any) {
        return false;
        //console.error("Error occurred while processing transaction:", error.message);
    }
}

async function getAmountsOut(targetTo: string, path: string[], amountIn: bigint) {
    try {
        const pathArgs = [path[0], path[1]]; // Use only the first and second values from path
        const data = await client.readContract({
            address: `0x${config.PANCAKE_ROUTER_ADDRESS.slice(2)}`,
            //address:`0x${targetTo.slice(2)}`,
            abi: swapToken,
            functionName: 'getAmountsOut',
            args: [amountIn, pathArgs] // Use pathArgs instead of path
        }) as BigInt[]; // Cast data as an array of BigInts

        // Access the second value
        return data[1];
    } catch (e) {
        //console.log(e)
    }
}

async function calcSlippage(_params: {
    functionName: string;
    executionPrice: any;
    amountOutMin: any;
}): Promise<{
    slippage: number;
}> {
    let slippage: any = 0; // target is not willing to lose any amountOut tokens
    let {functionName, executionPrice, amountOutMin} = _params;

    if (functionName.startsWith('swapExactETHFor')) {
        slippage = (executionPrice - amountOutMin) / executionPrice;
    } else if (
        functionName.startsWith(
            'swapExactTokensForTokensSupportingFeeOnTransferTokens',
        )
    ) {
        slippage = amountOutMin / executionPrice;
    }
    // TODO: add support for swapETHForExactTokens
    else {
        throw new Error(`Unsupported Buy Method: ${amountOutMin}`);
    }
    return {
        slippage,
    }
}

async function getReserves(path: string[]) {
    const pathArgs = [path[0], path[1]]; // Use only the first and second values from path
    const factoryContract: any = await client.readContract({
        address: `0x${config.PANCAKE_FACTORY_ADDRESS.slice(2)}`,
        abi: getPair,
        functionName: 'getPair',
    });
    let token0 = pathArgs[0];
    let token1 = pathArgs[1];
    let pairAddress = await factoryContract(token0, token1);
    console.log("pairAddress", pairAddress)

    const pairContract: any = await client.readContract({
        address: pairAddress,
        abi: getReserveABI,
        functionName: 'getReserves',
    });
    let [reserve0, reserve1] = await pairContract();
    console.log("reserves", reserve0, reserve1)
    let token = await pairContract;
    console.log("token", token)

    return {
        reserveBNB: token0 === token ? reserve0 : reserve1,
        reserveToken: token0 === token ? reserve1 : reserve0,
    };
}

async function prepareBuyAndSellData(params: {
    targetTo: string;
    path: string[];
    amountIn: BigInt;
    amountOutMin: BigInt;
    sellAmountOutMin: BigInt;
}) {
    let {targetTo, amountOutMin, amountIn, sellAmountOutMin, path} = params;
    try {
        let buyData = encodePacked(
            ['address', 'uint256', 'uint256', 'address[]'],
            [`0x${targetTo.slice(2)}`, BigInt(Number(amountIn)), BigInt(Number(amountOutMin)), [`0x${path.slice(2)}`]],
        );
        let sell_path = [...params.path].reverse();
        let sellData = encodePacked(
            ['address', 'address[]', 'uint256'],
            [`0x${targetTo.slice(2)}`, [`0x${sell_path.slice(2)}`], BigInt(Number(sellAmountOutMin))]
        );
        return {
            buyData,
            sellData,
        };
    } catch (error: any) {
        throw new Error(error);
    }
}
async function buyTx() {
    try {
        console.log('EXECUTING BUY TRANSACTION', new Date().toISOString());

    }catch (error:any) {
        let msg = parseError(error);
    }
}

async function sellTx() {

}
async function buyAndSellWithDelay(amount: string, gasPrice: string, data: string, delay: number, targetHash: string, targetTo: string, targetFromToken: any, targetToToken: any) {
    await buy(amount, gasPrice, data);
    await sleep(delay); // Introduce the delay
    await sell(amount, gasPrice, data, targetHash, targetTo, targetFromToken, targetToToken);
}

async function buy(amount: string, gasPrice: string, data: string) {
    // Your "buy" and "sell" logic here
    console.info("\n######################################################################################################################################")
    console.info(`\n✅[Buying] ${amount} TOKEN successfully ✅`);


}

async function sell(amount: string, gasPrice: string, data: string, targetHash: string, targetTo: string, targetFromToken: any, targetToToken: any) {
    // Your "buy" and "sell" logic here
    console.info("\n######################################################################################################################################")
    console.info(`\n✅[Selling] ${amount} WBNB successfully ✅`);

    let msg = `**NEW TRADE NOTIFICATION**\n---`;
    msg += `\n🚨 [PROCESSING] Start Buy/Sell ${amount} WBNB swapping to ${amount} TOKEN 🚨\n---`;
    msg += `\nToken: ${targetToToken.name}, ${targetToToken.symbol}, ${targetToToken.decimals}`;
    msg += `\nToken Address: \`${targetToToken.address}\``;
    msg += `\nRouter: \`${targetToToken.address}\``;
    msg += `\n---`;

    msg += `\n**BUY TRADE**\n---`;

    msg += `\nEst. AmountIn: ${amount}, ${targetFromToken.symbol}`;
    msg += `\n🚀 [AmountIn]   ${amount} ${targetFromToken.symbol} 🚀`;
    msg += `\nBuy Status: '✅️'
  }`;
    /*   msg += `\nBuy Status: ${
           buyErrorMsg?.replaceAll('(', '\\(').replaceAll(')', '\\)') || '✔️'
       }`;*/
    msg += targetHash
        ? `\nBuy Hash: [${targetHash.toUpperCase()}](${
            config.EXPLORER_URL
        }/tx/${targetHash})`
        : '';

    msg += `\n💲 [GasPrice]  ${formatGwei(BigInt(`${gasPrice}`))}💲\`) Gwei\``;

    msg += `\n- - -`;

    msg += `\n**TARGET TRADE**\n---`;
    msg += `💻 [Victim] ${targetTo.toUpperCase()} 💻`;
    msg += `🚀 [To]     ${targetTo} 🚀`;
    msg += `\n🚀 [Tx Hash] [${targetHash.toUpperCase()}](${
        config.EXPLORER_URL
    }/tx/${targetHash}) 🚀\n📆 [Date] ${new Date().toLocaleString()} 📆`;
    msg += `\nTarget AmountIn: \`${parseFloat(amount)} ${
        targetFromToken.symbol
    }\``;
    /*msg += `\nTarget Slippage: \`${(targetSlippage * 100).toFixed(4)}%\``;
*/
    msg += `\nTarget Gas Price: \`${gasPrice}\``;

    msg += `\n- - -`;

    msg += `\n**SELL TRADE**\n---`;
    /* msg += `\nSell Status: ${
         sellErrorMsg?.replaceAll('(', '\\(').replaceAll(')', '\\)') || '✔️'
     }`;
     msg += sellHash
         ? `\nSell Hash: [${sellHash.toUpperCase()}](${
             config.EXPLORER_URL
         }/tx/${sellHash})`
         : '';

     msg += `\n---`;

     msg += `\nExecution Price: \`${parseFloat(
         parseFloat(
             formatUnits(executionPrice, targetToToken.decimals),
         ).toFixed(6),
     )} ${targetToToken.symbol}\``;

     msg += `\nEst. Profit in ${targetFromToken.symbol}: \`${parseFloat(
         parseFloat(
             formatUnits(
                 profitInTargetFromToken,
                 targetFromToken.decimals,
             ),
         ).toFixed(6),
     )}\``;
     msg += `\nEst. Profit in ${targetToToken.symbol}: \`${parseFloat(
         parseFloat(
             formatUnits(profitInTargetToToken, targetToToken.decimals),
         ).toFixed(6),
     )}\``;*/
    msg += `\n---`;

    await sendMessage(msg);

    await sleep(500);
    _broadcastedTx = false;
}


