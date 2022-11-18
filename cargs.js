const OPERATOR = "0x7340D1FeCD4B64A4ac34f826B21c945d44d7407F"; // multisig
const SOMM_TOKEN = "0xa670d7237398238DE01267472C6f13e5B8010FD1";
const TOKEN = "0x4986fD36b6b16f49b43282Ee2e24C5cF90ed166d";
const oneDaySec = 60 * 60 * 24;

module.exports = [
    OPERATOR,                         // gravity (deployer for now)
    TOKEN,                    // cellar lp token
    SOMM_TOKEN,                       // SOMM ERC20 token
    60 * 60 * 24 * 14,                // 14 days,
    "100000000000000000",   // 30% short boost (0.75 factor)
    "200000000000000000",   // 40% medium boost (1 factor)
    "250000000000000000",   // 44% long boost (1.1 factor)
    oneDaySec * 10,                   // 10-day short locktime
    oneDaySec * 14,                   // 14-day medium locktime
    oneDaySec * 20,                   // 20-day long locktime
];

