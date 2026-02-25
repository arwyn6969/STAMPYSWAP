/*
 * tokenscan.js
 *
 * Custom javascript for TokenScan explorer

 */
// Function to handle displaying an address (including multi-sig addresses)
function getDisplayAddress(address, full){
    var html = '',
        full = (full) ? true : false,
        arr  = address.split('_');
    if(arr.length>1){
        html = '<a href="/address/' + address + '">Multisig Address</a> (' + arr[0] + '-of-' + arr[arr.length-1] + ')';
        // Handle displaying full address info
        if(full){
            arr.forEach(function(addr, idx){
                if(idx>0 && idx<(arr.length-1)){
                    html += '<br/><a href="/address/' + addr + '">' + addr +'</a>';
                }
            });
        }
    } else {
        html += '<a href="/address/' + address + '">' + address +'</a>';
    }
    return html;
}

// Function to handle making a URL a url valid by ensuring it starts with http or https
function getValidUrl( url ){
    var re1 = /^http:\/\//,
        re2 = /^https:\/\//;
    if(!(re1.test(url)||re2.test(url)))
        url = 'http://' + url;
    return url;
}

// Function to handle converting from hex to a string
function hex2string(hexx) {
    var hex = hexx.toString();//force conversion
    var str = '';
    for (var i = 0; (i < hex.length && hex.substr(i, 2) !== '00'); i += 2)
        str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    return str;
}

// Function to handle converting a base64 string to a hex
function base64ToHex(str) {
    const raw = atob(str);
    let result = '';
    for (let i = 0; i < raw.length; i++) {
        const hex = raw.charCodeAt(i).toString(16);
        result += (hex.length === 2 ? hex : '0' + hex);
    }
    return result;
}

// Handle automatically collapsing/expanding tabs to the 'More' menu item
function autoCollapseTabs(rerun=false){
    var tabs  = $('#data-tabs'),
        more  = $('#data-tabs-more'),
        last  = $('#data-last-tab'),
        max   = tabs.width(),
        width = last.width(),
        main  = [],
        menu  = [];
    // Loop through items and add to the correct array 
    tabs.find('li.tab').each(function(idx, item){
        var w = $(item).width();
        width += w;
        if(width <= max){
            main.push(item);
        } else {
            menu.push(item);
        }
    });
    // Move menu items to the correct locations
    main.forEach(function(item){ $(item).insertBefore(last); });
    menu.forEach(function(item){ more.append(item); });
    // Handle hiding/showing the 'More' menu
    if(menu.length==0)
        last.hide();
    else
        last.show();
    // If the tab bar is taller than 50 pixels, we are too tall, re-run the logic
    var h = tabs.height();
    if(tabs.height()>50 && !rerun)
        autoCollapseTabs(true);
}

// Handle checking if an asset is an ASS
function isASS(asset){
    var asset_upper = String(asset).toUpperCase();
    if(ASS_CARDS[asset] || ASS_CARDS[asset_upper])
        return true;
    return false;
}

// Handle returning info on an ASS (asset, image, project, website, etc)
function getASSInfo(asset){
    var info = ASS_CARDS[asset];
    return info;
}

// Handle getting a cookie and returning its value (if any)
function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
}

// Define placeholder where NFT cards data will live
ASS_CARDS = [];

$(document).ready(function(){

    // Setup alias to localStorage
    var sm = localStorage;

    // Build out ASS_CARDS array 
    if(typeof ASS_DATA !== 'undefined'){
        Object.entries(ASS_DATA).forEach(([key, value]) => {
            ASS_CARDS[key] = value;
        });
        // console.log('ASS_DATA=',ASS_DATA);
        // console.log('ASS_CARDS=',ASS_CARDS);
    }

    /*
     * Handle toggling display of numerics
     */
    var hideNumerics = sm.getItem('hide_numerics') || 0,
        cookieVal    = getCookie('hide_numerics'),
        domainVal    = window.location.hostname;

    // Display the correct numeric toggle text
    if(hideNumerics){
        // If numerics are supposed to be disabled and we dont have a cookie, set it and reload page so it is passed with requests
        if(cookieVal!=1){
            document.cookie = "hide_numerics=1; expires=Thu, 18 Dec 2050 12:00:00 UTC; path=/; domain=" + domainVal;
            location.reload();
        } else {
            $('#numerics-toggle span').html('Show');
        }
    }

    // Handle hiding / showing numerics
    $('#numerics-toggle').click(function(e){
        if(hideNumerics){
            sm.removeItem('hide_numerics');
            document.cookie = "hide_numerics=; expires=Thu, 18 Dec 2000 12:00:00 UTC; path=/; domain=" + domainVal;
        } else {
            document.cookie = "hide_numerics=1; expires=Thu, 18 Dec 2050 12:00:00 UTC; path=/; domain=" + domainVal;
            sm.setItem('hide_numerics',1);
        }
        location.reload();
    });

});